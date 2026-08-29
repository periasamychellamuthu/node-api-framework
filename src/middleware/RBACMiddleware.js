const dataAccess = require('../../APIFramework/Database/ORM/DataAccess');
const { SelectQueryImpl, Criteria, Column, Table, Join } = require('../../APIFramework/Database/QueryBuilder');

class RBACMiddleware {

    static _permCache = new Map();
    static CACHE_TTL_MS = 5 * 60 * 1000;

    static enforce(resource, action) {
        return async (req, res, next) => {
            if (!req.memberId) {
                console.error('[RBACMiddleware] req.memberId is not set. OrgContextFilter must run before RBACMiddleware.');
                return res.status(500).json({
                    response_status: { status_code: 5000, status: 'failed', message: 'Server configuration error.' }
                });
            }

            const permKey  = `${resource}:${action}`;
            const memberId = req.memberId;
            const orgId    = req.orgId;

            try {
                const permissions = await RBACMiddleware._loadPermissions(memberId, orgId, req.rangeStart, req.rangeEnd);

                if (permissions.has(permKey)) {
                    console.log(`[RBACMiddleware] Granted: member=${memberId} → ${permKey}`);
                    req.permissions = permissions;
                    return next();
                }

                console.warn(`[RBACMiddleware] Denied: member=${memberId} missing permission '${permKey}'`);
                return res.status(403).json({
                    response_status: { status_code: 4003, status: 'failed', message: `Access denied. Missing permission: ${permKey}` }
                });
            } catch (err) {
                console.error(`[RBACMiddleware] Permission check error: ${err.message}`);
                return res.status(500).json({
                    response_status: { status_code: 5000, status: 'failed', message: 'Permission check failed.' }
                });
            }
        };
    }

    static enforceAll(requiredPerms) {
        return async (req, res, next) => {
            if (!req.memberId) {
                return res.status(500).json({
                    response_status: { status_code: 5000, status: 'failed', message: 'Server configuration error.' }
                });
            }

            const memberId = req.memberId;
            const orgId    = req.orgId;

            try {
                const permissions = await RBACMiddleware._loadPermissions(memberId, orgId, req.rangeStart, req.rangeEnd);
                const missing     = requiredPerms.filter(p => !permissions.has(`${p.resource}:${p.action}`));

                if (missing.length === 0) {
                    req.permissions = permissions;
                    return next();
                }

                console.warn(`[RBACMiddleware] Denied: member=${memberId} missing ${missing.map(p => `${p.resource}:${p.action}`).join(', ')}`);
                return res.status(403).json({
                    response_status: { status_code: 4003, status: 'failed', message: `Access denied. Missing permissions: ${missing.map(p => `${p.resource}:${p.action}`).join(', ')}` }
                });
            } catch (err) {
                console.error(`[RBACMiddleware] Permission check error: ${err.message}`);
                return res.status(500).json({
                    response_status: { status_code: 5000, status: 'failed', message: 'Permission check failed.' }
                });
            }
        };
    }

    static invalidateCache(memberId) {
        RBACMiddleware._permCache.delete(memberId);
        console.log(`[RBACMiddleware] Cache invalidated for member ${memberId}`);
    }

    static async _loadPermissions(memberId, orgId, rangeStart, rangeEnd) {
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
        sq.setCriteria(
            Criteria.eq(Column.getColumn('ur', 'member_id'), memberId)
                .and(Criteria.between(Column.getColumn('ur', 'member_id'), rangeStart, rangeEnd))
        );

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
