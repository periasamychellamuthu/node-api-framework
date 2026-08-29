const bcrypt              = require('bcryptjs');
const TokenService        = require('./TokenService');
const dataAccess          = require('../Database/ORM/DataAccess');
const SequenceGenerator   = require('../Database/SequenceGenerator');
const SecurityGatewayFilter = require('./SecurityGatewayFilter');
const OrgContextFilter      = require('./OrgContextFilter');
const { SelectQueryImpl, Criteria, Column, Table } = require('../Database/QueryBuilder');

const SALT_ROUNDS = 10;

const ORG_HANDLE_REGEX    = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$|^[a-z0-9]{3,50}$/;
const ORG_HANDLE_RESERVED = new Set(['api', 'admin', 'auth', 'www', 'mail', 'static', 'assets', 'org', 'app']);

const SYSTEM_ROLES = [
    { name: 'OrgAdmin',     description: 'Full access to all org resources and settings' },
    { name: 'ModuleConfig', description: 'Can create and configure custom modules' },
    { name: 'Member',       description: 'Basic access — read only on accessible modules' }
];

const COOKIE_OPTS = {
    httpOnly: true,
    secure:   true,
    sameSite: 'Strict',
    path:     '/'
};

class AuthController {

    async signup(req, res) {
        try {
            const inputData = req.body?.input_data?.auth_account;
            if (!inputData) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'Expected payload: { "input_data": { "auth_account": { ... } } }' }
                });
            }

            const { email, password, display_name, phone, street, city, state, country, postal_code } = inputData;
            if (!email || !password || !display_name) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'email, password, and display_name are required' }
                });
            }

            const existingSq = new SelectQueryImpl(Table.getTable('iam_auth_accounts'));
            existingSq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'auth_account_id'));
            existingSq.setCriteria(Criteria.eq(Column.getColumn('iam_auth_accounts', 'email'), email));
            const existing = await dataAccess.getOne(existingSq);
            if (existing) {
                return res.status(409).json({
                    response_status: { status_code: 4009, status: 'failed', message: 'An account with this email already exists' }
                });
            }

            const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
            const now          = new Date();

            const accountDobj = dataAccess.constructDataObject();
            const accountRow  = dataAccess.newRow('iam_auth_accounts');
            accountRow.set('email',             email);
            accountRow.set('password_hash',     passwordHash);
            accountRow.set('auth_provider',     'local');
            accountRow.set('is_email_verified', 0);
            accountRow.set('status',            'active');
            accountRow.set('created_at',        now);
            accountDobj.addRow(accountRow);
            await dataAccess.add(accountDobj);

            const fetchSq = new SelectQueryImpl(Table.getTable('iam_auth_accounts'));
            fetchSq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'auth_account_id'));
            fetchSq.setCriteria(Criteria.eq(Column.getColumn('iam_auth_accounts', 'email'), email));
            const createdRow    = await dataAccess.getOne(fetchSq);
            const authAccountId = createdRow.get('auth_account_id');

            const profileDobj = dataAccess.constructDataObject();
            const profileRow  = dataAccess.newRow('iam_account_profiles');
            profileRow.set('auth_account_id', authAccountId);
            profileRow.set('display_name',    display_name);
            profileRow.set('phone',           phone       || null);
            profileRow.set('street',          street      || null);
            profileRow.set('city',            city        || null);
            profileRow.set('state',           state       || null);
            profileRow.set('country',         country     || null);
            profileRow.set('postal_code',     postal_code || null);
            profileRow.set('updated_at',      now);
            profileDobj.addRow(profileRow);
            await dataAccess.add(profileDobj);

            const accessToken  = TokenService.generateAccessToken(authAccountId);
            const refreshToken = TokenService.generateRefreshToken(authAccountId);

            console.log(`[Auth] Signup complete: email=${email}, auth_account_id=${authAccountId}`);

            res.cookie('iam_adt', accessToken,  { ...COOKIE_OPTS, maxAge: 3_600 * 1000 });
            res.cookie('iam_bdt', refreshToken, { ...COOKIE_OPTS, maxAge: 30 * 24 * 3_600 * 1000 });

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success' },
                auth_account: { auth_account_id: authAccountId, email },
                token: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 }
            });
        } catch (err) {
            console.error(`[Auth] Signup error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    async login(req, res) {
        try {
            const inputData = req.body?.input_data?.auth_account;
            if (!inputData) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'Expected payload: { "input_data": { "auth_account": { "email": ..., "password": ... } } }' }
                });
            }

            const { email, password } = inputData;
            if (!email || !password) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'email and password are required' }
                });
            }

            const sq = new SelectQueryImpl(Table.getTable('iam_auth_accounts'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'auth_account_id'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'email'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'password_hash'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'status'));
            sq.setCriteria(Criteria.eq(Column.getColumn('iam_auth_accounts', 'email'), email));

            const accountRow = await dataAccess.getOne(sq);
            if (!accountRow) {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Invalid email or password' }
                });
            }

            const status = accountRow.get('status');
            if (status !== 'active') {
                return res.status(403).json({
                    response_status: { status_code: 4003, status: 'failed', message: `Account is ${status}` }
                });
            }

            const isValid = await bcrypt.compare(password, accountRow.get('password_hash'));
            if (!isValid) {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Invalid email or password' }
                });
            }

            const authAccountId = accountRow.get('auth_account_id');

            const loginDobj = dataAccess.constructDataObject();
            const loginRow  = dataAccess.newRow('iam_auth_accounts');
            loginRow.set('auth_account_id', authAccountId);
            loginRow.markFetched();
            loginRow.set('last_login_at', new Date());
            loginDobj.updateRow(loginRow);
            await dataAccess.update(loginDobj);

            SecurityGatewayFilter.invalidateAccountStatusCache(authAccountId);

            const accessToken  = TokenService.generateAccessToken(authAccountId);
            const refreshToken = TokenService.generateRefreshToken(authAccountId);

            console.log(`[Auth] Login: auth_account_id=${authAccountId}`);

            res.cookie('iam_adt', accessToken,  { ...COOKIE_OPTS, maxAge: 3_600 * 1000 });
            res.cookie('iam_bdt', refreshToken, { ...COOKIE_OPTS, maxAge: 30 * 24 * 3_600 * 1000 });

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success' },
                auth_account: { auth_account_id: authAccountId, email: accountRow.get('email') },
                token: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 }
            });
        } catch (err) {
            console.error(`[Auth] Login error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    async refresh(req, res) {
        try {
            const refreshTokenValue = req.body?.input_data?.token?.refresh_token;
            if (!refreshTokenValue) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'Expected payload: { "input_data": { "token": { "refresh_token": "..." } } }' }
                });
            }

            let decoded;
            try {
                decoded = TokenService.verifyToken(refreshTokenValue);
            } catch (err) {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Invalid or expired refresh token' }
                });
            }

            if (decoded.type !== 'refresh') {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Invalid token type — expected refresh token' }
                });
            }

            const authAccountId = parseInt(decoded.sub, 10);

            const sq = new SelectQueryImpl(Table.getTable('iam_auth_accounts'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'auth_account_id'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'status'));
            sq.setCriteria(Criteria.eq(Column.getColumn('iam_auth_accounts', 'auth_account_id'), authAccountId));

            const accountRow = await dataAccess.getOne(sq);
            if (!accountRow || accountRow.get('status') !== 'active') {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Account not found or inactive' }
                });
            }

            const accessToken = TokenService.generateAccessToken(authAccountId);
            res.cookie('iam_adt', accessToken, { ...COOKIE_OPTS, maxAge: 3_600 * 1000 });

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success' },
                token: { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }
            });
        } catch (err) {
            console.error(`[Auth] Refresh error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    async logout(req, res) {
        try {
            let token = null;
            const authHeader = req.headers['authorization'];
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            } else if (req.cookies && req.cookies.iam_adt) {
                token = req.cookies.iam_adt;
            }

            if (token) {
                const decoded = TokenService.decodeToken(token);
                if (decoded && decoded.jti && decoded.exp) {
                    const expiresAt = new Date(decoded.exp * 1000);
                    await SecurityGatewayFilter.blacklistToken(
                        decoded.jti,
                        req.authAccountId,
                        'logout',
                        expiresAt
                    );
                }
            }

            res.clearCookie('iam_adt', { path: '/' });
            res.clearCookie('iam_bdt', { path: '/' });

            console.log(`[Auth] Logout: auth_account_id=${req.authAccountId}`);

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success', message: 'Logged out successfully' }
            });
        } catch (err) {
            console.error(`[Auth] Logout error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    async createOrg(req, res) {
        if (!req.authAccountId) {
            return res.status(401).json({
                response_status: { status_code: 4001, status: 'failed', message: 'Authentication required' }
            });
        }

        const inputData = req.body?.input_data?.org;
        if (!inputData) {
            return res.status(400).json({
                response_status: { status_code: 4000, status: 'failed', message: 'Expected payload: { "input_data": { "org": { "name": "...", "org_handle": "..." } } }' }
            });
        }

        const { name, org_handle, domain } = inputData;
        if (!name || !org_handle) {
            return res.status(400).json({
                response_status: { status_code: 4000, status: 'failed', message: 'name and org_handle are required' }
            });
        }

        if (!ORG_HANDLE_REGEX.test(org_handle)) {
            return res.status(400).json({
                response_status: { status_code: 4000, status: 'failed', message: 'org_handle must be 3-50 lowercase alphanumeric characters or hyphens, cannot start/end with hyphen' }
            });
        }
        if (ORG_HANDLE_RESERVED.has(org_handle.toLowerCase())) {
            return res.status(400).json({
                response_status: { status_code: 4000, status: 'failed', message: `org_handle '${org_handle}' is reserved` }
            });
        }

        const orgCheckSq = new SelectQueryImpl(Table.getTable('organizations'));
        orgCheckSq.addSelectColumn(Column.getColumn('organizations', 'org_id'));
        orgCheckSq.setCriteria(Criteria.eq(Column.getColumn('organizations', 'org_handle'), org_handle));
        const existingOrg = await dataAccess.getOne(orgCheckSq);
        if (existingOrg) {
            return res.status(409).json({
                response_status: { status_code: 4009, status: 'failed', message: `org_handle '${org_handle}' is already taken` }
            });
        }

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
                const orgFetched = await dataAccess.getOne(orgFetchSq, trx);
                const orgId      = parseInt(orgFetched.get('org_id'), 10);

                // Step 2: Allocate org ID range
                const { rangeStart, rangeEnd } = await SequenceGenerator.allocateOrgRange(orgId, trx);

                // Step 3: Attach range to request context
                req.orgId      = orgId;
                req.rangeStart = rangeStart;
                req.rangeEnd   = rangeEnd;

                // Step 4: INSERT org_members for creator
                const memberId    = await SequenceGenerator.getNextId(orgId);
                const memberDobj  = dataAccess.constructDataObject();
                const memberRow   = dataAccess.newRow('org_members');
                memberRow.set('member_id',       memberId);
                memberRow.set('auth_account_id', authAccountId);
                memberRow.set('status',          'active');
                memberRow.set('joined_at',       now);
                memberDobj.addRow(memberRow);
                await dataAccess.add(memberDobj, trx);

                // Step 5: Seed system roles
                const roleIds = {};
                for (const roleDef of SYSTEM_ROLES) {
                    const roleId    = await SequenceGenerator.getNextId(orgId);
                    const roleDobj  = dataAccess.constructDataObject();
                    const roleRow   = dataAccess.newRow('roles');
                    roleRow.set('role_id',       roleId);
                    roleRow.set('name',          roleDef.name);
                    roleRow.set('is_system_role', 1);
                    roleRow.set('description',   roleDef.description);
                    roleDobj.addRow(roleRow);
                    await dataAccess.add(roleDobj, trx);
                    roleIds[roleDef.name] = roleId;
                }

                // Step 6: Assign OrgAdmin role to creator
                const urDobj = dataAccess.constructDataObject();
                const urRow  = dataAccess.newRow('user_roles');
                urRow.set('member_id', memberId);
                urRow.set('role_id',   roleIds['OrgAdmin']);
                urRow.set('granted_at', now);
                urRow.set('granted_by', memberId);
                urDobj.addRow(urRow);
                await dataAccess.add(urDobj, trx);

                return { orgId, memberId, rangeStart, rangeEnd };
            });

            // Warm OrgContextFilter caches for fast first request
            OrgContextFilter._orgCache.set(org_handle, { orgId: result.orgId, status: 'active', cachedAt: Date.now() });
            OrgContextFilter._rangeCache.set(result.orgId, { rangeStart: result.rangeStart, rangeEnd: result.rangeEnd, cachedAt: Date.now() });
            OrgContextFilter._memberCache.set(`${authAccountId}:${result.orgId}`, {
                memberId: result.memberId, status: 'active', cachedAt: Date.now()
            });

            console.log(`[Auth] Org created: handle=${org_handle}, org_id=${result.orgId}, member_id=${result.memberId}, range=${result.rangeStart}-${result.rangeEnd}`);

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success' },
                org:        { org_id: result.orgId, name, org_handle, domain: domain || null, status: 'active' },
                membership: { member_id: result.memberId, role: 'OrgAdmin' }
            });

        } catch (err) {
            console.error(`[Auth] createOrg error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }
}

module.exports = new AuthController();
