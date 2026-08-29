/**
 * VersatileCredentials — Per-request identity + org context value object.
 *
 * SDP equivalent: SDPCredentials
 *
 * In SDP, SDPCredentials is a thread-local object populated by IAMListener /
 * SDPCredentialsFilter and carried through the entire request lifecycle. It holds
 * the resolved technician/user identity, tenant dataspace, and role set.
 *
 * In Versatile (Node.js, single-threaded), we attach this object to the Express
 * request as `req.$credentials`. It is populated exactly once per request by
 * OrgContextFilter after all three resolution steps succeed:
 *   1. SecurityGatewayFilter → verifies JWT  → sets req.authAccountId
 *   2. OrgContextFilter      → resolves org  → sets req.orgId, rangeStart, rangeEnd
 *   3. OrgContextFilter      → resolves membership → sets req.memberId
 *   4. OrgContextFilter      → resolves roles → constructs VersatileCredentials
 *      → sets req.$credentials
 *
 * After OrgContextFilter runs, ALL downstream layers use req.$credentials:
 *
 *   XMLSecurityMiddleware  → req.$credentials.roles        (role whitelist check)
 *   AbstractEntityHandler  → req.$credentials.memberId     (created_by / audit)
 *   AbstractEntityHandler  → req.$credentials.rangeStart/End (range-scoped queries)
 *   DBUtils / Knex queries → req.$credentials.rangeStart/End (BETWEEN scoping)
 *   Listeners              → req.$credentials              (full context for side effects)
 *
 * The object is intentionally immutable after construction (Object.freeze).
 * No code outside OrgContextFilter should modify or replace req.$credentials.
 *
 * Field inventory:
 * ┌─────────────────────┬────────────────────────────────────────────────────────┐
 * │ Field               │ Description                                            │
 * ├─────────────────────┼────────────────────────────────────────────────────────┤
 * │ authAccountId       │ iam_auth_accounts.auth_account_id (from JWT sub)       │
 * │ memberId            │ org_members.member_id (org-scoped identity)            │
 * │ orgId               │ organizations.org_id                                   │
 * │ orgHandle           │ organizations.org_handle (URL segment)                 │
 * │ rangeStart          │ org_id_ranges.range_start — lower bound of org PK range│
 * │ rangeEnd            │ org_id_ranges.range_end   — upper bound of org PK range│
 * │ roles               │ string[] — role names from user_roles + roles tables   │
 * └─────────────────────┴────────────────────────────────────────────────────────┘
 *
 * SDP → Versatile mapping:
 * ┌──────────────────────────────────┬─────────────────────────────────┐
 * │ SDP SDPCredentials field         │ VersatileCredentials field       │
 * ├──────────────────────────────────┼─────────────────────────────────┤
 * │ getAccountId()                   │ authAccountId                   │
 * │ getLoginName() / getUserId()     │ memberId                        │
 * │ getTenantId()                    │ orgId                           │
 * │ getDataspaceName()               │ orgHandle                       │
 * │ getRoles()                       │ roles                           │
 * │ ThreadLocal dataspace boundaries │ rangeStart / rangeEnd           │
 * └──────────────────────────────────┴─────────────────────────────────┘
 */
class VersatileCredentials {

    /**
     * @param {object} params
     * @param {number}   params.authAccountId  — iam_auth_accounts.auth_account_id
     * @param {number}   params.memberId       — org_members.member_id
     * @param {number}   params.orgId          — organizations.org_id
     * @param {string}   params.orgHandle      — organizations.org_handle
     * @param {number}   params.rangeStart     — org_id_ranges.range_start
     * @param {number}   params.rangeEnd       — org_id_ranges.range_end
     * @param {string[]} params.roles          — resolved role names for this member in this org
     */
    constructor({ authAccountId, memberId, orgId, orgHandle, rangeStart, rangeEnd, roles }) {
        this.authAccountId = authAccountId;
        this.memberId      = memberId;
        this.orgId         = orgId;
        this.orgHandle     = orgHandle;
        this.rangeStart    = rangeStart;
        this.rangeEnd      = rangeEnd;
        this.roles         = Array.isArray(roles) ? [...roles] : [];

        // Freeze — credentials must not be mutated after construction.
        // Array must be frozen before the containing object.
        Object.freeze(this.roles);
        Object.freeze(this);  // strict mode required for assignment errors on frozen objects
    }

    // ─── Convenience helpers (mirrors SDP SDPCredentials API style) ───────────

    /** Returns true if the member holds the given role name in this org. */
    hasRole(roleName) {
        return this.roles.includes(roleName);
    }

    /** Returns true if the member holds ANY of the given role names. */
    hasAnyRole(...roleNames) {
        return roleNames.some(r => this.roles.includes(r));
    }

    /** Returns true if the member holds ALL of the given role names. */
    hasAllRoles(...roleNames) {
        return roleNames.every(r => this.roles.includes(r));
    }

    /**
     * Returns a plain object safe for logging (no secrets — member IDs and roles only).
     */
    toLogContext() {
        return {
            authAccountId: this.authAccountId,
            memberId:      this.memberId,
            orgId:         this.orgId,
            orgHandle:     this.orgHandle,
            roles:         this.roles
        };
    }
}

module.exports = VersatileCredentials;
