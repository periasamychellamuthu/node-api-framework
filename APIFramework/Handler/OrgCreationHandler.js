const dataAccess          = require('../Database/ORM/DataAccess');
const SequenceGenerator   = require('../Database/SequenceGenerator'); // used directly: allocateOrgRange + getNextIdSync (no RequestContext during org creation)
const OrgContextFilter    = require('../IAM/OrgContextFilter');
const { SelectQueryImpl, Criteria, Column, Table } = require('../Database/QueryBuilder');
const { success, fail }  = require('../Utils/ResponseUtil');

const ORG_HANDLE_REGEX    = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$|^[a-z0-9]{3,50}$/;
const ORG_HANDLE_RESERVED = new Set(['api', 'admin', 'auth', 'www', 'mail', 'static', 'assets', 'org', 'app']);

const SYSTEM_ROLES = [
    { name: 'OrgAdmin',     description: 'Full access to all org resources and settings' },
    { name: 'ModuleConfig', description: 'Can create and configure custom modules' },
    { name: 'Member',       description: 'Basic access — read only on accessible modules' }
];

/**
 * OrgCreationHandler — handles organization creation.
 *
 * Extracted from AuthController (which still owns signup/login/refresh/logout).
 * Bound directly as an authenticated Express route in main.js:
 *   app.post('/api/v1/orgs', OrgCreationHandler.createOrg.bind(OrgCreationHandler));
 *
 * On success, creates the organization, allocates its ID range, adds the
 * creator as the first org_member, seeds the system roles, and grants the
 * creator the OrgAdmin role — all inside a single DB transaction.
 */
class OrgCreationHandler {

    async createOrg(req, res) {
        if (!req.authAccountId) return fail(res, 401, 4001, 'Authentication required');

        const inputData = req.body?.input_data?.org;
        if (!inputData) return fail(res, 400, 4000, 'Expected payload: { "input_data": { "org": { "name": "...", "org_handle": "..." } } }');

        const { name, org_handle, domain } = inputData;
        if (!name || !org_handle) return fail(res, 400, 4000, 'name and org_handle are required');

        if (!ORG_HANDLE_REGEX.test(org_handle)) return fail(res, 400, 4000, 'org_handle must be 3-50 lowercase alphanumeric characters or hyphens, cannot start/end with hyphen');
        if (ORG_HANDLE_RESERVED.has(org_handle.toLowerCase())) return fail(res, 400, 4000, `org_handle '${org_handle}' is reserved`);

        const orgCheckSq = new SelectQueryImpl(Table.getTable('organizations'));
        orgCheckSq.addSelectColumn(Column.getColumn('organizations', 'org_id'));
        orgCheckSq.setCriteria(Criteria.eq(Column.getColumn('organizations', 'org_handle'), org_handle));
        // getOneRaw — organizations is a global table (AUTO_INCREMENT PK), no range context at this point
        const existingOrg = await dataAccess.getOneRaw(orgCheckSq);
        if (existingOrg) return fail(res, 409, 4009, `org_handle '${org_handle}' is already taken`);

        const authAccountId = req.authAccountId;

        try {
            const result = await dataAccess.transaction(async (trx) => {
                const now = new Date();

                // Step 1: INSERT organizations (AUTO_INCREMENT PK — not range-scoped)
                const orgDobj = dataAccess.constructDataObject();
                const orgRow  = dataAccess.newRow('organizations');
                orgRow.set('name',       name);
                orgRow.set('org_handle', org_handle);
                orgRow.set('domain',     domain || null);
                orgRow.set('status',     'active');
                orgRow.set('created_at', now);
                orgDobj.addRow(orgRow);
                await dataAccess.add(orgDobj, trx);

                // Fetch the generated org_id
                const orgFetchSq = new SelectQueryImpl(Table.getTable('organizations'));
                orgFetchSq.addSelectColumn(Column.getColumn('organizations', 'org_id'));
                orgFetchSq.setCriteria(Criteria.eq(Column.getColumn('organizations', 'org_handle'), org_handle));
                // getOneRaw — fetching the AUTO_INCREMENT org_id immediately after INSERT, no range context
                const orgFetched = await dataAccess.getOneRaw(orgFetchSq, trx);
                const orgId      = parseInt(orgFetched.get('org_id'), 10);

                // Step 2: Allocate org ID range
                const { rangeStart, rangeEnd } = await SequenceGenerator.allocateOrgRange(orgId, trx);

                // Step 3: Attach range to request context
                req.orgId      = orgId;
                req.rangeStart = rangeStart;
                req.rangeEnd   = rangeEnd;

                // Steps 4–6: INSERT org_members + roles + user_roles in one DataObject.
                //
                // OrgCreationHandler is an explicit seeding path — there is no active
                // RequestContext yet (the org doesn't exist until this transaction commits).
                // Row.get() would throw because it can't read orgId from ALS.
                // So PKs are assigned explicitly here via SequenceGenerator.getNextIdSync(orgId)
                // — the range was just cached by allocateOrgRange() above, so sync is safe.
                // This is the one legitimate place where row.set(pk, id) is used directly.
                const seedDobj = dataAccess.constructDataObject();

                // org_members — creator
                const memberId  = SequenceGenerator.getNextIdSync(orgId);
                const memberRow = dataAccess.newRow('org_members');
                memberRow.set('member_id',       memberId);
                memberRow.set('auth_account_id', authAccountId);
                memberRow.set('status',          'active');
                memberRow.set('joined_at',       now);
                seedDobj.addRow(memberRow);

                // roles — seed all system roles and collect their IDs
                const roleIds = {};
                for (const roleDef of SYSTEM_ROLES) {
                    const roleId  = SequenceGenerator.getNextIdSync(orgId);
                    const roleRow = dataAccess.newRow('roles');
                    roleRow.set('role_id',        roleId);
                    roleRow.set('name',           roleDef.name);
                    roleRow.set('is_system_role',  1);
                    roleRow.set('description',    roleDef.description);
                    seedDobj.addRow(roleRow);
                    roleIds[roleDef.name] = roleId;
                }

                // user_roles — grant OrgAdmin to creator
                const urRow = dataAccess.newRow('user_roles');
                urRow.set('member_id',  memberId);
                urRow.set('role_id',    roleIds['OrgAdmin']);
                urRow.set('granted_at', now);
                urRow.set('granted_by', memberId);
                seedDobj.addRow(urRow);

                await dataAccess.add(seedDobj, trx);

                return { orgId, memberId, rangeStart, rangeEnd };
            });

            // Warm OrgContextFilter caches for fast first request
            OrgContextFilter._orgCache.set(org_handle, { orgId: result.orgId, status: 'active', cachedAt: Date.now() });
            OrgContextFilter._rangeCache.set(result.orgId, { rangeStart: result.rangeStart, rangeEnd: result.rangeEnd, cachedAt: Date.now() });
            OrgContextFilter._memberCache.set(`${authAccountId}:${result.orgId}`, {
                memberId: result.memberId, status: 'active', cachedAt: Date.now()
            });

            console.log(`[OrgCreationHandler] Org created: handle=${org_handle}, org_id=${result.orgId}, member_id=${result.memberId}, range=${result.rangeStart}-${result.rangeEnd}`);

            return success(res, {
                org:        { org_id: result.orgId, name, org_handle, domain: domain || null, status: 'active' },
                membership: { member_id: result.memberId, role: 'OrgAdmin' }
            });

        } catch (err) {
            console.error(`[OrgCreationHandler] createOrg error: ${err.message}`);
            return fail(res, 500, 5000, err.message);
        }
    }
}

module.exports = new OrgCreationHandler();
