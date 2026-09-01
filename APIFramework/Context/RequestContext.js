'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * RequestContext — Per-request ALS (AsyncLocalStorage) wrapper.
 *
 * SDP equivalent: SDPCredentials thread-local
 *
 * In SDP, credentials and tenant context were stored in a ThreadLocal that was
 * available to any class in the call stack without passing it as a parameter.
 * In Node.js (single-threaded, async), AsyncLocalStorage is the exact equivalent:
 * the store is bound to one async call chain and never leaks across concurrent requests.
 *
 * ── Store shape ──────────────────────────────────────────────────────────────
 *   { credentials: VersatileCredentials, apiRequest: APIRequest }
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
        return _als.run({ credentials, apiRequest }, fn);
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
}

module.exports = RequestContext;
