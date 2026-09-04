'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * RequestContext — Per-request ALS (AsyncLocalStorage) wrapper.
 *
 * Stores per-request credentials and org context in AsyncLocalStorage so any
 * layer in the call stack (handler, validator, listener, ORM) can read them
 * without parameter passing. The store is bound to one async call chain and
 * never leaks across concurrent requests.
 *
 * ── Store shape ──────────────────────────────────────────────────────────────
 *   {
 *     credentials: VersatileCredentials,
 *     apiRequest:  APIRequest,
 *     transaction: Knex.Transaction | null   ← active trx, managed by TransactionManager
 *   }
 *
 * ── Who sets it ──────────────────────────────────────────────────────────────
 *   DefaultRouterHandler — the single entry point for ALL entity XML-based API calls.
 *   It calls RequestContext.run(req.$credentials, apiRequest, fn) once per request.
 *   IAM routes (AuthController, OrgContextFilter internals) never call run() —
 *   those routes use req directly and are completely unaffected.
 *
 * ── Who reads it ─────────────────────────────────────────────────────────────
 *   DataAccess.get()    — auto-injects range criteria on every scoped SELECT
 *   DataAccess.getOne() — auto-injects range criteria on every scoped SELECT
 *   PreDefaultEntityHandler — reads orgId for SequenceGenerator
 *   TransactionManager  — reads/writes the transaction slot for reentrancy checks
 *   Listeners, validators, custom handlers — read memberId, orgId, roles, apiRequest
 *
 * ── Method summary ───────────────────────────────────────────────────────────
 *   RequestContext.run(credentials, apiRequest, fn) — start context, run fn() inside it
 *   RequestContext.get()                 — returns full VersatileCredentials or null
 *   RequestContext.getAPIRequest()       — returns the current APIRequest or null
 *   RequestContext.getOrgId()            — organizations.org_id
 *   RequestContext.getMemberId()         — org_members.member_id
 *   RequestContext.getRangeStart()       — org_id_ranges.range_start
 *   RequestContext.getRangeEnd()         — org_id_ranges.range_end
 *   RequestContext.getRoles()            — string[] of role names
 *   RequestContext.getAuthAccountId()    — iam_auth_accounts.auth_account_id
 *   RequestContext.hasContext()          — true if inside a run() scope
 *   RequestContext.getTransaction()      — returns active Knex trx or null
 *   RequestContext.setTransaction(trx)   — stores active trx (called by TransactionManager)
 *   RequestContext.clearTransaction()    — clears trx after commit/rollback
 */

// One ALS instance lives for the entire server lifetime.
// It stores a different { credentials, apiRequest } object per concurrent request.
const _als = new AsyncLocalStorage();

class RequestContext {

    /**
     * Starts an ALS context for this request and runs fn() inside it.
     *
     * Called exactly ONCE per entity API request, in DefaultRouterHandler,
     * after OrgContextFilter has already populated req.$credentials.
     *
     * Everything fn() awaits — handler, dataAccess, listeners, validators,
     * helpers — can call RequestContext accessors and will see this same store,
     * with NO parameter passing.
     *
     * @param {VersatileCredentials} credentials   req.$credentials (set by OrgContextFilter)
     * @param {APIRequest}           apiRequest    the parsed APIRequest for this call
     * @param {Function}             fn            the async function to run inside context
     * @returns {Promise<any>}                     whatever fn() returns
     */
    static run(credentials, apiRequest, fn) {
        // transaction slot starts null — TransactionManager sets it on beginTxn()
        return _als.run({ credentials, apiRequest, transaction: null }, fn);
    }

    /**
     * Returns the full VersatileCredentials for the current request.
     * Returns null if called outside a run() scope (IAM routes, timers, background jobs).
     *
     * @returns {VersatileCredentials | null}
     */
    static get() {
        return _als.getStore()?.credentials ?? null;
    }

    /**
     * Returns the APIRequest for the current request.
     * Returns null if called outside a run() scope.
     *
     * @returns {APIRequest | null}
     */
    static getAPIRequest() {
        return _als.getStore()?.apiRequest ?? null;
    }

    // ── Typed convenience accessors ───────────────────────────────────────────
    // Callers never need to null-check the full credentials object.
    // Each accessor returns null/[] when there is no active context.

    /** @returns {number | null} organizations.org_id */
    static getOrgId() {
        return _als.getStore()?.credentials?.orgId ?? null;
    }

    /** @returns {number | null} org_members.member_id (product identity) */
    static getMemberId() {
        return _als.getStore()?.credentials?.memberId ?? null;
    }

    /** @returns {number | null} org_id_ranges.range_start — lower PK bound for this org */
    static getRangeStart() {
        return _als.getStore()?.credentials?.rangeStart ?? null;
    }

    /** @returns {number | null} org_id_ranges.range_end — upper PK bound for this org */
    static getRangeEnd() {
        return _als.getStore()?.credentials?.rangeEnd ?? null;
    }

    /** @returns {string[]} role names for this member in this org (e.g. ['OrgAdmin']) */
    static getRoles() {
        return _als.getStore()?.credentials?.roles ?? [];
    }

    /** @returns {number | null} iam_auth_accounts.auth_account_id (from JWT sub) */
    static getAuthAccountId() {
        return _als.getStore()?.credentials?.authAccountId ?? null;
    }

    /**
     * Returns true if a request context is currently active.
     * Use this for defensive checks inside DataAccess or listeners.
     *
     * @returns {boolean}
     */
    static hasContext() {
        return _als.getStore() != null;
    }

    // ── Transaction slot — managed exclusively by TransactionManager ──────────
    //
    // These three methods are the only read/write points for the transaction slot.
    // No other layer should touch the transaction slot directly.
    // TransactionManager is the sole owner of begin/commit/rollback logic.

    /**
     * Returns the active Knex transaction for this request, or null if none is open.
     *
     * Used by TransactionManager.beginTxn() to detect an already-open transaction
     * (reentrancy check) before calling knex.transaction() again.
     *
     * @returns {import('knex').Knex.Transaction | null}
     */
    static getTransaction() {
        return _als.getStore()?.transaction ?? null;
    }

    /**
     * Stores an active Knex transaction in the ALS store for this request.
     *
     * Called by TransactionManager.beginTxn() immediately after knex.transaction()
     * returns a new trx. Any nested handler/utility in this async call chain will
     * then see it via getTransaction() and join rather than opening a new one.
     *
     * @param {import('knex').Knex.Transaction} trx
     */
    static setTransaction(trx) {
        const store = _als.getStore();
        if (store) store.transaction = trx;
    }

    /**
     * Clears the transaction slot after a commit or rollback.
     *
     * Called by TransactionManager after the outermost transaction owner completes.
     * Ensures the next logical operation (e.g. a subsequent handler call on the same
     * request, or a nested utility that comes after the outer commit) does not
     * accidentally join a closed transaction.
     */
    static clearTransaction() {
        const store = _als.getStore();
        if (store) store.transaction = null;
    }
}

module.exports = RequestContext;
