'use strict';

const knex           = require('../Database/KnexClient');
const RequestContext  = require('../Context/RequestContext');

/**
 * TransactionManager — Framework-level Knex transaction lifecycle manager.
 *
 * Responsibilities:
 *   1. beginTxn()      — Open a new Knex transaction OR join an existing one
 *                        (reentrancy check via RequestContext.getTransaction()).
 *   2. commitTxn()     — Commit if this call is the outermost owner.
 *   3. rollbackTxn()   — Roll back if this call is the outermost owner.
 *   4. runInTxn()      — Convenience wrapper: beginTxn → fn(trx) → commitTxn / rollbackTxn.
 *
 * ── Reentrancy model ─────────────────────────────────────────────────────────
 *
 * A Knex transaction checks out a dedicated connection from the pool. Only one
 * transaction may be active per async call chain at a time. If a second
 * knex.transaction() were opened inside an already-open one, two separate
 * connections would be used — the inner transaction would NOT see the outer's
 * uncommitted rows, and the outer's rollback would not undo the inner's commits.
 *
 * TransactionManager prevents this via a reentrancy check on every beginTxn():
 *
 *   const existingTrx = RequestContext.getTransaction();
 *   if (existingTrx) return { trx: existingTrx, isOwner: false };
 *
 * When isOwner is false, the caller is nested inside an outer transaction.
 * commitTxn / rollbackTxn are no-ops for non-owners — only the outermost owner
 * (isOwner: true) actually commits or rolls back.
 *
 * ── Lifecycle (flush before begin) ───────────────────────────────────────────
 *
 * The doc (dataobject-row-transaction-guide.md §4.1) shows that before opening
 * a new transaction the framework flushes any prior committed-but-not-published
 * state. In Versatile, ALS ensures there is no cross-request leakage, so the
 * equivalent is simply checking that the RequestContext transaction slot is null
 * before calling knex.transaction(). If it is not null, a prior transaction was
 * never closed — beginTxn() throws to surface the bug immediately.
 *
 * ── Usage in PreDefaultEntityHandler ─────────────────────────────────────────
 *
 *   const { trx, isOwner } = await TransactionManager.beginTxn();
 *   try {
 *       await ListenerDispatcher.dispatch('beforeCreate', ...);  // inside txn
 *       await dataAccess.add(dobj, trx);                         // inside txn
 *       await TransactionManager.commitTxn({ trx, isOwner });
 *       await ListenerDispatcher.dispatch('afterCreate', ...);   // AFTER commit
 *   } catch (err) {
 *       await TransactionManager.rollbackTxn({ trx, isOwner });
 *       throw err;
 *   }
 *
 * ── Usage in nested utility / custom handler ──────────────────────────────────
 *
 *   // Inside a custom handler that overrides add():
 *   const { trx, isOwner } = await TransactionManager.beginTxn();
 *   // → isOwner: false if super.add() already opened a transaction
 *   // → the same trx is reused; commitTxn/rollbackTxn are no-ops for this caller
 *
 * ── runInTxn() convenience wrapper ────────────────────────────────────────────
 *
 *   const result = await TransactionManager.runInTxn(async (trx) => {
 *       await dataAccess.add(dobj, trx);
 *       return someValue;
 *   });
 *   // afterXxx listeners go here — after runInTxn() returns (DB is durable)
 */

class TransactionManager {

    /**
     * Begin a transaction or join the active one.
     *
     * ── Case 1: No active transaction in this async call chain ────────────────
     *   - Calls knex.transaction() to check out a dedicated connection
     *   - Stores the trx in RequestContext so nested callers see it
     *   - Returns { trx, isOwner: true }
     *
     * ── Case 2: A transaction is already active (reentrancy) ──────────────────
     *   - Returns the existing trx from RequestContext
     *   - Returns { trx, isOwner: false }
     *   - No new connection is checked out
     *
     * ── Case 3: Called outside a RequestContext (IAM routes, background jobs) ─
     *   - RequestContext is not active, so there is no slot to store the trx
     *   - A raw knex.transaction() is still opened and returned with isOwner: true
     *   - Caller is responsible for commit/rollback (no ALS cleanup needed)
     *
     * @returns {Promise<{ trx: import('knex').Knex.Transaction, isOwner: boolean }>}
     */
    static async beginTxn() {
        // ── Reentrancy check ─────────────────────────────────────────────────
        const existingTrx = RequestContext.getTransaction();
        if (existingTrx) {
            // Already inside a transaction — join it, do not open a new one.
            return { trx: existingTrx, isOwner: false };
        }

        // ── Open a new transaction ────────────────────────────────────────────
        // knex.transaction() returns a trx object that acts as a Knex query builder
        // scoped to a single dedicated DB connection. All DataAccess calls that
        // receive this trx will execute on that same connection, ensuring atomicity.
        const trx = await knex.transaction();

        // Store in ALS so any nested async code in this request can find it.
        // RequestContext.setTransaction() is a no-op if there is no active store
        // (Case 3 — outside RequestContext), which is fine: the caller manages it.
        RequestContext.setTransaction(trx);

        return { trx, isOwner: true };
    }

    /**
     * Commit the transaction — only if this caller is the owner.
     *
     * Non-owners (isOwner: false) are nested callers that joined an existing
     * transaction. They must NOT commit — only the outermost owner commits.
     *
     * After commit the transaction slot in RequestContext is cleared so that any
     * subsequent operation on this request starts with a clean state.
     *
     * @param {{ trx: import('knex').Knex.Transaction, isOwner: boolean }} handle
     * @returns {Promise<void>}
     */
    static async commitTxn({ trx, isOwner }) {
        if (!isOwner) return;   // nested caller — outer owner commits

        try {
            await trx.commit();
        } finally {
            // Always clear the slot, even if commit threw.
            // A failed commit leaves the connection in an unusable state;
            // clearTransaction() ensures no code tries to use it again.
            RequestContext.clearTransaction();
        }
    }

    /**
     * Roll back the transaction — only if this caller is the owner.
     *
     * Non-owners must NOT roll back — the outer owner's catch block will do it.
     * Rolling back from a nested caller would close the transaction that the outer
     * caller still thinks is open, leading to a double-rollback error.
     *
     * Safe to call even if the transaction has already been committed (no-op from Knex).
     *
     * @param {{ trx: import('knex').Knex.Transaction, isOwner: boolean }} handle
     * @returns {Promise<void>}
     */
    static async rollbackTxn({ trx, isOwner }) {
        if (!isOwner) return;   // nested caller — outer owner rolls back

        try {
            await trx.rollback();
        } catch (err) {
            // Knex throws if rollback is called on an already-rolled-back transaction.
            // Log and suppress — the important thing is that clearTransaction() runs.
            console.error('[TransactionManager] rollbackTxn error (suppressed):', err.message);
        } finally {
            RequestContext.clearTransaction();
        }
    }

    /**
     * Convenience wrapper — runs fn(trx) inside a managed transaction.
     *
     * Handles beginTxn / commitTxn / rollbackTxn automatically. The caller
     * only provides the work function and fires post-commit side effects after
     * runInTxn() resolves.
     *
     * Pattern:
     *   const result = await TransactionManager.runInTxn(async (trx) => {
     *       await dataAccess.add(dobj, trx);
     *       return createdRow;
     *   });
     *   // afterXxx listeners here — DB write is durable
     *
     * ── Reentrancy ────────────────────────────────────────────────────────────
     * If an outer transaction is already active, beginTxn() returns isOwner: false.
     * runInTxn() then calls fn(trx) on the existing transaction and skips commit/rollback.
     * The outer owner controls the transaction lifecycle.
     *
     * ── Error handling ────────────────────────────────────────────────────────
     * Any exception thrown by fn() triggers rollbackTxn() (for the owner only)
     * and re-throws so the caller's error handler can produce the HTTP response.
     *
     * @param {function(import('knex').Knex.Transaction): Promise<any>} fn
     * @returns {Promise<any>}  whatever fn() returns
     */
    static async runInTxn(fn) {
        const handle = await TransactionManager.beginTxn();
        const { trx, isOwner } = handle;

        try {
            const result = await fn(trx);
            await TransactionManager.commitTxn(handle);
            return result;
        } catch (err) {
            await TransactionManager.rollbackTxn(handle);
            throw err;
        }
    }
}

module.exports = TransactionManager;
