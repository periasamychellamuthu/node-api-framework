const dataAccess     = require('../../APIFramework/Database/ORM/DataAccess');
const RequestContext = require('../../APIFramework/Context/RequestContext');
const { SelectQueryImpl, Criteria, Column, Table, Join } = require('../../APIFramework/Database/QueryBuilder');
const { fail }       = require('../../APIFramework/Utils/ResponseUtil');

class RBACMiddleware {

    static _permCache = new Map();
    static CACHE_TTL_MS = 5 * 60 * 1000;

    static enforce(resource, action) {
        return async (req, res, next) => {
            const memberId = RequestContext.getMemberId();
            if (!memberId) {
                console.error('[RBACMiddleware] RequestContext has no memberId. DefaultRouterHandler must wrap before RBACMiddleware.');
                return fail(res, 500, 5000, 'Server configuration error.');
            }

            const permKey = `${resource}:${action}`;

            try {
                const permissions = await RBACMiddleware._loadPermissions(memberId);

                if (permissions.has(permKey)) {
                    console.log(`[RBACMiddleware] Granted: member=${memberId} → ${permKey}`);
                    req.permissions = permissions;
                    return next();
                }

                console.warn(`[RBACMiddleware] Denied: member=${memberId} missing permission '${permKey}'`);
                return fail(res, 403, 4003, `Access denied. Missing permission: ${permKey}`);
            } catch (err) {
                console.error(`[RBACMiddleware] Permission check error: ${err.message}`);
                return fail(res, 500, 5000, 'Permission check failed.');
            }
        };
    }

    static enforceAll(requiredPerms) {
        return async (req, res, next) => {
            const memberId = RequestContext.getMemberId();
            if (!memberId) return fail(res, 500, 5000, 'Server configuration error.');

            try {
                const permissions = await RBACMiddleware._loadPermissions(memberId);
                const missing     = requiredPerms.filter(p => !permissions.has(`${p.resource}:${p.action}`));

                if (missing.length === 0) {
                    req.permissions = permissions;
                    return next();
                }

                console.warn(`[RBACMiddleware] Denied: member=${memberId} missing ${missing.map(p => `${p.resource}:${p.action}`).join(', ')}`);
                return fail(res, 403, 4003, `Access denied. Missing permissions: ${missing.map(p => `${p.resource}:${p.action}`).join(', ')}`);
            } catch (err) {
                console.error(`[RBACMiddleware] Permission check error: ${err.message}`);
                return fail(res, 500, 5000, 'Permission check failed.');
            }
        };
    }

    static invalidateCache(memberId) {
        RBACMiddleware._permCache.delete(memberId);
        console.log(`[RBACMiddleware] Cache invalidated for member ${memberId}`);
    }

    /**
     * Loads all permissions for a member.
     *
     * Runs inside RequestContext.run() (called by DefaultRouterHandler), so
     * DataAccess.get() auto-injects the org range into the query — no need
     * to pass rangeStart/rangeEnd explicitly here.
     */
    static async _loadPermissions(memberId) {
        const cached = RBACMiddleware._permCache.get(memberId);
        if (cached && (Date.now() - cached.cachedAt) < RBACMiddleware.CACHE_TTL_MS) {
            return cached.permissions;
        }

        const urTable  = Table.getTable('user_roles',       'ur');
        const rpTable  = Table.getTable('role_permissions',  'rp');
        const pTable   = Table.getTable('permissions',       'p');

        const sq = new SelectQueryImpl(urTable);
        sq.addSelectColumn(Column.getColumn('p', 'resource'));
        sq.addSelectColumn(Column.getColumn('p', 'action'));
        sq.addJoin(new Join(urTable, rpTable, ['role_id'],       ['role_id'],       Join.INNER));
        sq.addJoin(new Join(rpTable, pTable,  ['permission_id'], ['permission_id'], Join.INNER));
        // Filter by the specific member — range scoping is auto-injected by DataAccess.get()
        sq.setCriteria(Criteria.eq(Column.getColumn('ur', 'member_id'), memberId));

        const rows    = await dataAccess.get(sq);
        const permSet = new Set();
        for (const row of (rows || [])) {
            permSet.add(`${row.get('resource')}:${row.get('action')}`);
        }

        RBACMiddleware._permCache.set(memberId, { permissions: permSet, cachedAt: Date.now() });
        return permSet;
    }
}

module.exports = RBACMiddleware;
