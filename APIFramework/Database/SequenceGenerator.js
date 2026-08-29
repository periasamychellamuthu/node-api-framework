const knex = require('./KnexClient');

/**
 * SequenceGenerator — Org-scoped shared ID range model.
 *
 * Architecture (architecture-knowledge-base.md §5):
 *   - One range allocated per org when the org is created.
 *   - Range block size: 1 crore = 10,000,000 IDs.
 *   - All entities within one org share the SAME single counter.
 *   - Global table `id_range_allocator` (single row, 'global' key) tracks next available block end.
 *   - Per-org table `org_id_ranges` stores (org_id, range_start, range_end, current_val).
 *   - In-memory Map<orgId, number> for the current counter — avoids a DB hit per insert.
 *   - Periodic flush writes current_val back to DB every FLUSH_INTERVAL_MS.
 *   - Gaps are acceptable — guaranteed globally unique, not gap-free.
 *
 * Node.js note:
 *   No true AtomicLong exists in Node.js single-threaded runtime.
 *   The in-memory Map is race-safe within a single Node.js process.
 *   For multi-process deployments (cluster mode), each process has its own in-memory counter
 *   — the DB `current_val` acts as the authoritative floor on restart.
 *
 * Naming:
 *   IAM tables (iam_auth_accounts, organizations, etc.) use global AUTO_INCREMENT PKs managed
 *   by MySQL directly — they do NOT go through SequenceGenerator.
 *   SequenceGenerator is ONLY for org-scoped product entity PKs.
 */

const BLOCK_SIZE       = 10_000_000;  // 1 crore per org
const FLUSH_INTERVAL_MS = 5_000;      // flush counters to DB every 5 seconds

class SequenceGenerator {

    constructor() {
        // In-memory current counters per org: Map<orgId(number), number>
        this._counters = new Map();

        // Range boundaries per org loaded on first use: Map<orgId, { rangeStart, rangeEnd }>
        this._ranges   = new Map();

        // Track which orgs have dirty (unflushed) counters
        this._dirty    = new Set();

        // Start periodic flush
        this._flushTimer = setInterval(() => this._flushAll(), FLUSH_INTERVAL_MS);
        // unref so the timer doesn't prevent Node from exiting
        if (this._flushTimer.unref) this._flushTimer.unref();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Get the next ID for a given org.
     * Loads the org's range from DB on first call (or if not yet in memory).
     * All subsequent calls within the org's range are served from memory — zero DB hits.
     *
     * @param {number} orgId  — org_id from the organizations table
     * @returns {Promise<number>} globally unique, org-scoped ID
     */
    async getNextId(orgId) {
        if (!orgId) throw new Error('[SequenceGenerator] orgId is required.');

        // Load range into memory if not already cached
        if (!this._ranges.has(orgId)) {
            await this._loadRange(orgId);
        }

        const { rangeEnd } = this._ranges.get(orgId);
        const currentVal   = this._counters.get(orgId);
        const nextVal      = currentVal + 1;

        if (nextVal > rangeEnd) {
            // Range exhausted — not handled in Phase 1 (1 crore block is large enough)
            throw new Error(`[SequenceGenerator] Org ${orgId} has exhausted its ID range (${rangeEnd}). Range expansion is a future feature.`);
        }

        this._counters.set(orgId, nextVal);
        this._dirty.add(orgId);

        return nextVal;
    }

    /**
     * Allocate a fresh ID range for a newly created org.
     * Called ONCE per org during org creation, inside the org creation transaction.
     *
     * Atomically:
     *   1. FOR UPDATE lock on id_range_allocator row
     *   2. Compute new_start / new_end
     *   3. UPDATE id_range_allocator.last_range_end
     *   4. INSERT org_id_ranges row
     *
     * @param {number} orgId        — newly inserted org_id from organizations table
     * @param {object} connection   — active DB connection (from the org creation transaction)
     * @returns {Promise<{rangeStart: number, rangeEnd: number}>}
     */
    async allocateOrgRange(orgId, trx) {
        if (!orgId) throw new Error('[SequenceGenerator] orgId is required for range allocation.');

        const qb = trx || knex;

        // Lock the global allocator row to prevent concurrent overlap
        const allocatorRow = await qb('id_range_allocator')
            .where('allocator_key', 'global')
            .forUpdate()
            .first();

        if (!allocatorRow) {
            throw new Error('[SequenceGenerator] id_range_allocator global row not found. Was SchemaBuilder.seedFrameworkData() called?');
        }

        const lastEnd  = parseInt(allocatorRow.last_range_end, 10);
        const newStart = lastEnd + 1;
        const newEnd   = lastEnd + BLOCK_SIZE;

        await qb('id_range_allocator')
            .where('allocator_key', 'global')
            .update({ last_range_end: newEnd });

        await qb('org_id_ranges').insert({
            org_id:       orgId,
            range_start:  newStart,
            range_end:    newEnd,
            current_val:  0,
            allocated_at: new Date()
        });

        this._ranges.set(orgId, { rangeStart: newStart, rangeEnd: newEnd });
        this._counters.set(orgId, newStart - 1);

        console.log(`[SequenceGenerator] Allocated range for org ${orgId}: ${newStart}–${newEnd}`);
        return { rangeStart: newStart, rangeEnd: newEnd };
    }

    /**
     * Pre-load all org ranges from DB into memory at server startup.
     * Ensures that the in-memory counters start from the last persisted current_val.
     * Called once by SchemaBuilder after framework tables are confirmed to exist.
     */
    async loadAllRanges() {
        try {
            const rows = await knex('org_id_ranges')
                .select('org_id', 'range_start', 'range_end', 'current_val');
            for (const row of rows) {
                const orgId = parseInt(row.org_id, 10);
                this._ranges.set(orgId, {
                    rangeStart: parseInt(row.range_start, 10),
                    rangeEnd:   parseInt(row.range_end,   10)
                });
                this._counters.set(orgId, parseInt(row.current_val, 10));
            }
            console.log(`[SequenceGenerator] Pre-loaded ${rows.length} org range(s) into memory.`);
        } catch (err) {
            // Non-fatal on startup if table is empty (no orgs yet)
            console.warn(`[SequenceGenerator] loadAllRanges: ${err.message}`);
        }
    }

    /**
     * Force-flush all dirty counters to DB immediately.
     * Called on graceful shutdown to minimise gaps from unflushed counters.
     */
    async flushNow() {
        return this._flushAll();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Load a single org's range from DB into memory (lazy-load on first ID request).
     */
    async _loadRange(orgId) {
        const row = await knex('org_id_ranges')
            .where('org_id', orgId)
            .select('range_start', 'range_end', 'current_val')
            .first();
        if (!row) {
            throw new Error(`[SequenceGenerator] No ID range found for org ${orgId}. Was the org created via AuthController.createOrg()?`);
        }
        this._ranges.set(orgId, {
            rangeStart: parseInt(row.range_start, 10),
            rangeEnd:   parseInt(row.range_end,   10)
        });
        this._counters.set(orgId, parseInt(row.current_val, 10));
    }

    /**
     * Flush all dirty in-memory counters back to DB.
     * Runs on the periodic timer and on graceful shutdown.
     */
    async _flushAll() {
        if (this._dirty.size === 0) return;

        const toFlush = Array.from(this._dirty);
        this._dirty.clear();

        for (const orgId of toFlush) {
            const currentVal = this._counters.get(orgId);
            if (currentVal === undefined) continue;
            try {
                await knex('org_id_ranges')
                    .where('org_id', orgId)
                    .update({ current_val: currentVal });
            } catch (err) {
                // Re-mark as dirty so next flush retries
                this._dirty.add(orgId);
                console.error(`[SequenceGenerator] Flush failed for org ${orgId}: ${err.message}`);
            }
        }
    }
}

module.exports = new SequenceGenerator();
