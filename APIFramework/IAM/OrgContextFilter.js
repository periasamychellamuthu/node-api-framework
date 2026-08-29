const dataAccess           = require('../Database/ORM/DataAccess');
const VersatileCredentials = require('./VersatileCredentials');
const { SelectQueryImpl, Criteria, Column, Table, Join } = require('../Database/QueryBuilder');

class OrgContextFilter {

    static _orgCache    = new Map();
    static _rangeCache  = new Map();
    static _memberCache = new Map();
    static _rolesCache  = new Map();

    static ORG_CACHE_TTL_MS    = 5 * 60 * 1000;
    static RANGE_CACHE_TTL_MS  = 5 * 60 * 1000;
    static MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;
    static ROLES_CACHE_TTL_MS  = 5 * 60 * 1000;

    static ORG_URL_PREFIX = /^\/org\/([^/]+)(\/.*)?$/;

    static async handle(req, res, next) {
        const reqPath = req.path;
        const match   = OrgContextFilter.ORG_URL_PREFIX.exec(reqPath);
        if (!match) return next();

        const orgHandle = match[1];

        const org = await OrgContextFilter._resolveOrg(orgHandle);
        if (!org) {
            return res.status(404).json({
                response_status: { status_code: 4004, status: 'failed', message: `Organization '${orgHandle}' not found.` }
            });
        }
        if (org.status !== 'active') {
            return res.status(403).json({
                response_status: { status_code: 4003, status: 'failed', message: `Organization '${orgHandle}' is ${org.status}.` }
            });
        }

        const range = await OrgContextFilter._resolveRange(org.orgId);
        if (!range) {
            console.error(`[OrgContextFilter] No ID range for org ${org.orgId} (${orgHandle})`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: 'Organization configuration error.' }
            });
        }

        const authAccountId = req.authAccountId;
        if (!authAccountId) {
            return res.status(401).json({
                response_status: { status_code: 4001, status: 'failed', message: 'Authentication required.' }
            });
        }

        const member = await OrgContextFilter._resolveMember(
            authAccountId, org.orgId, range.rangeStart, range.rangeEnd
        );
        if (!member) {
            return res.status(403).json({
                response_status: { status_code: 4003, status: 'failed', message: 'You are not a member of this organization.' }
            });
        }
        if (member.status !== 'active') {
            return res.status(403).json({
                response_status: { status_code: 4003, status: 'failed', message: `Your membership in this organization is ${member.status}.` }
            });
        }

        const roles = await OrgContextFilter._resolveMemberRoles(
            member.memberId, range.rangeStart, range.rangeEnd
        );

        req.$credentials = new VersatileCredentials({
            authAccountId,
            memberId:   member.memberId,
            orgId:      org.orgId,
            orgHandle,
            rangeStart: range.rangeStart,
            rangeEnd:   range.rangeEnd,
            roles
        });

        req.orgId      = org.orgId;
        req.memberId   = member.memberId;
        req.rangeStart = range.rangeStart;
        req.rangeEnd   = range.rangeEnd;

        console.log(`[OrgContextFilter] Resolved → org=${orgHandle}(${org.orgId}), member=${member.memberId}, roles=[${roles.join(',')}], range=${range.rangeStart}-${range.rangeEnd}`);
        next();
    }

    static invalidateMemberCache(authAccountId, orgId) {
        OrgContextFilter._memberCache.delete(`${authAccountId}:${orgId}`);
    }

    static invalidateRolesCache(memberId) {
        OrgContextFilter._rolesCache.delete(memberId);
    }

    static invalidateOrgCache(orgHandle) {
        OrgContextFilter._orgCache.delete(orgHandle);
    }

    static async _resolveOrg(orgHandle) {
        const cached = OrgContextFilter._orgCache.get(orgHandle);
        if (cached && (Date.now() - cached.cachedAt) < OrgContextFilter.ORG_CACHE_TTL_MS) {
            return cached;
        }
        try {
            const sq = new SelectQueryImpl(Table.getTable('organizations'));
            sq.addSelectColumn(Column.getColumn('organizations', 'org_id'));
            sq.addSelectColumn(Column.getColumn('organizations', 'status'));
            sq.setCriteria(Criteria.eq(Column.getColumn('organizations', 'org_handle'), orgHandle));

            const row = await dataAccess.getOne(sq);
            if (!row) return null;

            const entry = { orgId: parseInt(row.get('org_id'), 10), status: row.get('status'), cachedAt: Date.now() };
            OrgContextFilter._orgCache.set(orgHandle, entry);
            return entry;
        } catch (err) {
            console.error(`[OrgContextFilter] Org resolve error for '${orgHandle}': ${err.message}`);
            return null;
        }
    }

    static async _resolveRange(orgId) {
        const cached = OrgContextFilter._rangeCache.get(orgId);
        if (cached && (Date.now() - cached.cachedAt) < OrgContextFilter.RANGE_CACHE_TTL_MS) {
            return cached;
        }
        try {
            const sq = new SelectQueryImpl(Table.getTable('org_id_ranges'));
            sq.addSelectColumn(Column.getColumn('org_id_ranges', 'range_start'));
            sq.addSelectColumn(Column.getColumn('org_id_ranges', 'range_end'));
            sq.setCriteria(Criteria.eq(Column.getColumn('org_id_ranges', 'org_id'), orgId));

            const row = await dataAccess.getOne(sq);
            if (!row) return null;

            const entry = {
                rangeStart: parseInt(row.get('range_start'), 10),
                rangeEnd:   parseInt(row.get('range_end'),   10),
                cachedAt:   Date.now()
            };
            OrgContextFilter._rangeCache.set(orgId, entry);
            return entry;
        } catch (err) {
            console.error(`[OrgContextFilter] Range resolve error for org ${orgId}: ${err.message}`);
            return null;
        }
    }

    static async _resolveMember(authAccountId, orgId, rangeStart, rangeEnd) {
        const cacheKey = `${authAccountId}:${orgId}`;
        const cached   = OrgContextFilter._memberCache.get(cacheKey);
        if (cached && (Date.now() - cached.cachedAt) < OrgContextFilter.MEMBER_CACHE_TTL_MS) {
            return cached;
        }
        try {
            const sq = new SelectQueryImpl(Table.getTable('org_members'));
            sq.addSelectColumn(Column.getColumn('org_members', 'member_id'));
            sq.addSelectColumn(Column.getColumn('org_members', 'status'));
            sq.setCriteria(
                Criteria.eq(Column.getColumn('org_members', 'auth_account_id'), authAccountId)
                    .and(Criteria.between(Column.getColumn('org_members', 'member_id'), rangeStart, rangeEnd))
            );

            const row = await dataAccess.getOne(sq);
            if (!row) return null;

            const entry = {
                memberId: parseInt(row.get('member_id'), 10),
                status:   row.get('status'),
                cachedAt: Date.now()
            };
            OrgContextFilter._memberCache.set(cacheKey, entry);
            return entry;
        } catch (err) {
            console.error(`[OrgContextFilter] Member resolve error for account ${authAccountId} org ${orgId}: ${err.message}`);
            return null;
        }
    }

    static async _resolveMemberRoles(memberId, rangeStart, rangeEnd) {
        const cached = OrgContextFilter._rolesCache.get(memberId);
        if (cached && (Date.now() - cached.cachedAt) < OrgContextFilter.ROLES_CACHE_TTL_MS) {
            return cached.roles;
        }

        try {
            const urTable = Table.getTable('user_roles', 'ur');
            const rTable  = Table.getTable('roles', 'r');

            const sq = new SelectQueryImpl(urTable);
            sq.addSelectColumn(Column.getColumn('r', 'name'));
            sq.addJoin(new Join(urTable, rTable, ['role_id'], ['role_id'], Join.INNER));
            sq.setCriteria(
                Criteria.eq(Column.getColumn('ur', 'member_id'), memberId)
                    .and(Criteria.between(Column.getColumn('ur', 'member_id'), rangeStart, rangeEnd))
                    .and(Criteria.between(Column.getColumn('ur', 'role_id'),   rangeStart, rangeEnd))
            );

            const rows  = await dataAccess.get(sq);
            const roles = rows.map(r => r.get('name'));
            OrgContextFilter._rolesCache.set(memberId, { roles, cachedAt: Date.now() });
            return roles;
        } catch (err) {
            console.error(`[OrgContextFilter] Role resolve error for member ${memberId}: ${err.message}`);
            return [];
        }
    }
}

module.exports = OrgContextFilter;
