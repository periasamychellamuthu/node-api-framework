const bcrypt = require('bcryptjs');
const TokenService = require('./TokenService');
const SQLConnect = require('../../src/database/MYSQL/connect');
const SequenceGenerator = require('../Database/SequenceGenerator');

const SALT_ROUNDS = 10;

// Cookie configuration
const COOKIE_OPTS = {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/'
};

// Default roles seeded for the tenant creator
const DEFAULT_ADMIN_ROLES = [
    'Admin', 'User', 'CreateRequests', 'ReadRequests',
    'UpdateRequests', 'DeleteRequests', 'SystemUser'
];

class AuthController {

    /**
     * POST /auth/signup
     * Payload: { "input_data": { "auth_account": { "email", "password", "display_name" } } }
     */
    async signup(req, res) {
        try {
            const inputData = req.body && req.body.input_data && req.body.input_data.auth_account;
            if (!inputData) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'Expected payload: { "input_data": { "auth_account": { ... } } }' }
                });
            }

            const { email, password, display_name } = inputData;

            if (!email || !password || !display_name) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'email, password, and display_name are required' }
                });
            }

            // Check if account already exists
            const existing = await AuthController._queryOne('SELECT id FROM auth_accounts WHERE email = ?', [email]);
            if (existing) {
                return res.status(409).json({
                    response_status: { status_code: 4008, status: 'failed', message: 'Account with this email already exists' }
                });
            }

            // Hash password
            const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

            // Generate ID via platform sequence
            const id = await SequenceGenerator.getNextId('platform', 'auth_accounts.id');

            // Insert account
            await AuthController._execute(
                'INSERT INTO auth_accounts (id, email, password_hash, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [id, email, passwordHash, display_name, 'active', Date.now()]
            );

            const account = { id, email, display_name };

            // Resolve tenant for token (account has no tenants yet on signup)
            const accessToken = TokenService.generateAccessToken(account, null, []);
            const refreshToken = TokenService.generateRefreshToken(account);

            console.log(`[Auth] Account created: ${email} (id: ${id})`);

            // Set auth cookies for browser navigation
            res.cookie('iam_adt', accessToken, { ...COOKIE_OPTS, maxAge: 3600 * 1000 });
            res.cookie('iam_bdt', refreshToken, { ...COOKIE_OPTS, maxAge: 30 * 24 * 3600 * 1000 });

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success' },
                auth_account: {
                    account_id: id,
                    email: email,
                    display_name: display_name
                },
                token: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    token_type: 'Bearer',
                    expires_in: 3600
                }
            });
        } catch (err) {
            console.error(`[Auth] Signup error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    /**
     * POST /auth/login
     * Payload: { "input_data": { "auth_account": { "email", "password" } } }
     */
    async login(req, res) {
        try {
            const inputData = req.body && req.body.input_data && req.body.input_data.auth_account;
            if (!inputData) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'Expected payload: { "input_data": { "auth_account": { ... } } }' }
                });
            }

            const { email, password } = inputData;

            if (!email || !password) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'email and password are required' }
                });
            }

            // Lookup account
            const account = await AuthController._queryOne(
                'SELECT id, email, password_hash, display_name, status FROM auth_accounts WHERE email = ?',
                [email]
            );

            if (!account) {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Invalid email or password' }
                });
            }

            if (account.status !== 'active') {
                return res.status(403).json({
                    response_status: { status_code: 4003, status: 'failed', message: 'Account is ' + account.status }
                });
            }

            // Verify password
            const isValid = await bcrypt.compare(password, account.password_hash);
            if (!isValid) {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Invalid email or password' }
                });
            }

            // Resolve default tenant and roles from DB
            const defaultTenant = await AuthController._queryOne(
                'SELECT tenant_id FROM account_tenants WHERE account_id = ? AND is_default = 1',
                [account.id]
            );
            const tenantId = defaultTenant ? defaultTenant.tenant_id : null;

            let roles = [];
            if (tenantId) {
                const roleRows = await AuthController._queryAll(
                    'SELECT role_name FROM account_roles WHERE account_id = ? AND tenant_id = ?',
                    [account.id, tenantId]
                );
                roles = roleRows.map(r => r.role_name);
            }

            const accessToken = TokenService.generateAccessToken(account, tenantId, roles);
            const refreshToken = TokenService.generateRefreshToken(account);

            console.log(`[Auth] Login successful: ${email}, tenant: ${tenantId}, roles: [${roles.join(',')}]`);

            // Set auth cookies for browser navigation
            res.cookie('iam_adt', accessToken, { ...COOKIE_OPTS, maxAge: 3600 * 1000 });
            res.cookie('iam_bdt', refreshToken, { ...COOKIE_OPTS, maxAge: 30 * 24 * 3600 * 1000 });

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success' },
                auth_account: {
                    account_id: account.id,
                    email: account.email,
                    display_name: account.display_name,
                    tenant_id: tenantId
                },
                token: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    token_type: 'Bearer',
                    expires_in: 3600
                }
            });
        } catch (err) {
            console.error(`[Auth] Login error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    /**
     * POST /auth/refresh
     * Payload: { "input_data": { "token": { "refresh_token": "..." } } }
     */
    async refresh(req, res) {
        try {
            const inputData = req.body && req.body.input_data && req.body.input_data.token;
            const refreshTokenValue = inputData && inputData.refresh_token;

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
                    response_status: { status_code: 4001, status: 'failed', message: 'Invalid token type' }
                });
            }

            // Lookup account
            const account = await AuthController._queryOne(
                'SELECT id, email, display_name, status FROM auth_accounts WHERE id = ?',
                [decoded.sub]
            );

            if (!account || account.status !== 'active') {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Account not found or inactive' }
                });
            }

            // Resolve tenant + roles
            const defaultTenant = await AuthController._queryOne(
                'SELECT tenant_id FROM account_tenants WHERE account_id = ? AND is_default = 1',
                [account.id]
            );
            const tenantId = defaultTenant ? defaultTenant.tenant_id : null;

            let roles = [];
            if (tenantId) {
                const roleRows = await AuthController._queryAll(
                    'SELECT role_name FROM account_roles WHERE account_id = ? AND tenant_id = ?',
                    [account.id, tenantId]
                );
                roles = roleRows.map(r => r.role_name);
            }

            const accessToken = TokenService.generateAccessToken(account, tenantId, roles);

            // Set refreshed access cookie
            res.cookie('iam_adt', accessToken, { ...COOKIE_OPTS, maxAge: 3600 * 1000 });

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success' },
                token: {
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: 3600
                }
            });
        } catch (err) {
            console.error(`[Auth] Refresh error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    /**
     * Seeds default admin roles for an account-tenant pair.
     * Called after a tenant is created, linking the creator to the new tenant.
     */
    static async seedAccountTenantRoles(accountId, tenantId) {
        // Link account to tenant
        const linkId = await SequenceGenerator.getNextId('platform', 'account_tenants.id');
        await AuthController._execute(
            'INSERT INTO account_tenants (id, account_id, tenant_id, is_default) VALUES (?, ?, ?, 1)',
            [linkId, accountId, tenantId]
        );

        // Seed default admin roles
        for (const role of DEFAULT_ADMIN_ROLES) {
            const roleId = await SequenceGenerator.getNextId('platform', 'account_roles.id');
            await AuthController._execute(
                'INSERT INTO account_roles (id, account_id, tenant_id, role_name) VALUES (?, ?, ?, ?)',
                [roleId, accountId, tenantId, role]
            );
        }
        console.log(`[Auth] Seeded ${DEFAULT_ADMIN_ROLES.length} roles for account ${accountId} in tenant ${tenantId}`);
    }

    /**
     * POST /auth/link-tenant
     * Payload: { "input_data": { "account_tenant": { "tenant_id": 123 } } }
     * Requires authentication. Links the current account to the given tenant and seeds admin roles.
     */
    async linkTenant(req, res) {
        try {
            if (!req.$credentials || !req.$credentials.accountId) {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Authentication required' }
                });
            }

            const inputData = req.body && req.body.input_data && req.body.input_data.account_tenant;
            if (!inputData || !inputData.tenant_id) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'Expected payload: { "input_data": { "account_tenant": { "tenant_id": ... } } }' }
                });
            }

            const accountId = req.$credentials.accountId;
            const tenantId = inputData.tenant_id;

            // Check if already linked
            const existing = await AuthController._queryOne(
                'SELECT account_id FROM account_tenants WHERE account_id = ? AND tenant_id = ?',
                [accountId, tenantId]
            );
            if (existing) {
                return res.status(409).json({
                    response_status: { status_code: 4008, status: 'failed', message: 'Account already linked to this tenant' }
                });
            }

            await AuthController.seedAccountTenantRoles(accountId, tenantId);

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success', message: 'Account linked to tenant with admin roles' }
            });
        } catch (err) {
            console.error(`[Auth] Link tenant error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    /**
     * POST /api/v1/create-tenant
     * Payload: { "input_data": { "tenant": { "name", "domain", "contact_email", "subscription_status" } } }
     * IAM-level tenant onboarding: creates tenant + links account + seeds admin roles.
     * This endpoint bypasses XMLSecurityMiddleware (registered before it) since the user
     * has no roles yet during initial onboarding.
     */
    async createTenant(req, res) {
        try {
            if (!req.$credentials || !req.$credentials.accountId) {
                return res.status(401).json({
                    response_status: { status_code: 4001, status: 'failed', message: 'Authentication required' }
                });
            }

            const inputData = req.body && req.body.input_data && req.body.input_data.tenant;
            if (!inputData) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'Expected payload: { "input_data": { "tenant": { ... } } }' }
                });
            }

            const { name, domain, contact_email, subscription_status } = inputData;
            if (!name || !domain || !contact_email) {
                return res.status(400).json({
                    response_status: { status_code: 4000, status: 'failed', message: 'name, domain, and contact_email are required' }
                });
            }

            const accountId = req.$credentials.accountId;

            // Check if account already has a tenant
            const existingLink = await AuthController._queryOne(
                'SELECT tenant_id FROM account_tenants WHERE account_id = ?', [accountId]
            );
            if (existingLink) {
                return res.status(409).json({
                    response_status: { status_code: 4008, status: 'failed', message: 'Account already belongs to a tenant' }
                });
            }

            // Create tenant
            const tenantId = await SequenceGenerator.getNextId('platform', 'tenants.id');
            await AuthController._execute(
                'INSERT INTO tenants (id, name, domain, contact_email, subscription_status) VALUES (?, ?, ?, ?, ?)',
                [tenantId, name, domain, contact_email, subscription_status || 'Active']
            );

            // Link account to tenant + seed roles
            await AuthController.seedAccountTenantRoles(accountId, tenantId);

            // Resolve the freshly seeded roles and generate new tokens
            const roleRows = await AuthController._queryAll(
                'SELECT role_name FROM account_roles WHERE account_id = ? AND tenant_id = ?',
                [accountId, tenantId]
            );
            const roles = roleRows.map(r => r.role_name);

            // Fetch account info for token generation
            const account = await AuthController._queryOne(
                'SELECT id, email, display_name FROM auth_accounts WHERE id = ?', [accountId]
            );

            const accessToken = TokenService.generateAccessToken(account, tenantId, roles);
            const refreshToken = TokenService.generateRefreshToken(account);

            // Set fresh cookies so browser is immediately authenticated with tenant + roles
            res.cookie('iam_adt', accessToken, { ...COOKIE_OPTS, maxAge: 3600 * 1000 });
            res.cookie('iam_bdt', refreshToken, { ...COOKIE_OPTS, maxAge: 30 * 24 * 3600 * 1000 });

            console.log(`[Auth] Tenant onboarding complete: tenant ${tenantId} for account ${accountId}, roles: [${roles.join(',')}]`);

            return res.status(200).json({
                response_status: { status_code: 2000, status: 'success' },
                tenant: {
                    id: tenantId,
                    name: name,
                    domain: domain,
                    contact_email: contact_email,
                    subscription_status: subscription_status || 'Active'
                },
                auth_account: {
                    account_id: accountId,
                    email: account.email,
                    display_name: account.display_name,
                    tenant_id: tenantId
                },
                token: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    token_type: 'Bearer',
                    expires_in: 3600
                }
            });
        } catch (err) {
            console.error(`[Auth] Create tenant error: ${err.message}`);
            return res.status(500).json({
                response_status: { status_code: 5000, status: 'failed', message: err.message }
            });
        }
    }

    // --- DB Helpers ---

    static _queryOne(sql, params) {
        return new Promise((resolve, reject) => {
            SQLConnect.pool.query(sql, params, (err, results) => {
                if (err) return reject(err);
                resolve(results && results.length > 0 ? results[0] : null);
            });
        });
    }

    static _queryAll(sql, params) {
        return new Promise((resolve, reject) => {
            SQLConnect.pool.query(sql, params, (err, results) => {
                if (err) return reject(err);
                resolve(results || []);
            });
        });
    }

    static _execute(sql, params) {
        return new Promise((resolve, reject) => {
            SQLConnect.pool.query(sql, params, (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });
    }
}

module.exports = new AuthController();
