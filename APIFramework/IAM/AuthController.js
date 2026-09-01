const bcrypt                = require('bcryptjs');
const TokenService          = require('./TokenService');
const dataAccess            = require('../Database/ORM/DataAccess');
const SecurityGatewayFilter = require('./SecurityGatewayFilter');
const { SelectQueryImpl, Criteria, Column, Table } = require('../Database/QueryBuilder');
const { success, fail }     = require('../Utils/ResponseUtil');

const SALT_ROUNDS = 10;

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
            if (!inputData) return fail(res, 400, 4000, 'Expected payload: { "input_data": { "auth_account": { ... } } }');

            const { email, password, display_name, phone, street, city, state, country, postal_code } = inputData;
            if (!email || !password || !display_name) return fail(res, 400, 4000, 'email, password, and display_name are required');

            const existingSq = new SelectQueryImpl(Table.getTable('iam_auth_accounts'));
            existingSq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'auth_account_id'));
            existingSq.setCriteria(Criteria.eq(Column.getColumn('iam_auth_accounts', 'email'), email));
            // getOneRaw — iam_auth_accounts is a global IAM table, not range-scoped
            const existing = await dataAccess.getOneRaw(existingSq);
            if (existing) return fail(res, 409, 4009, 'An account with this email already exists');

            const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
            const now          = new Date();

            // Single DataObject — both tables inserted atomically in one add() call.
            //
            // accountRow's PK (auth_account_id) is left unset — Row.get() returns a RowRef
            // placeholder. profileRow.set('auth_account_id', ...) stores that RowRef.
            // During DataAccess.add():
            //   1. iam_auth_accounts is inserted first (topo-sort: parent before child)
            //   2. AUTO_INCREMENT insertId is back-filled onto accountRow._current
            //   3. profileRow.toResolvedObject() calls RowRef.resolve() → gets real id
            //   4. iam_account_profiles is inserted with the real FK value
            const signupDobj = dataAccess.constructDataObject();

            const accountRow = dataAccess.newRow('iam_auth_accounts');
            accountRow.set('email',             email);
            accountRow.set('password_hash',     passwordHash);
            accountRow.set('auth_provider',     'local');
            accountRow.set('is_email_verified', 0);
            accountRow.set('status',            'active');
            accountRow.set('created_at',        now);
            signupDobj.addRow(accountRow);

            const profileRow = dataAccess.newRow('iam_account_profiles');
            // accountRow.get('auth_account_id') → RowRef (PK not set yet); resolved on INSERT
            profileRow.set('auth_account_id', accountRow.get('auth_account_id'));
            profileRow.set('display_name',    display_name);
            profileRow.set('phone',           phone        || null);
            profileRow.set('street',          street       || null);
            profileRow.set('city',            city         || null);
            profileRow.set('state',           state        || null);
            profileRow.set('country',         country      || null);
            profileRow.set('postal_code',     postal_code  || null);
            profileRow.set('updated_at',      now);
            signupDobj.addRow(profileRow);

            await dataAccess.add(signupDobj);

            // After add(), the back-filled real PK is available directly on the Row
            const authAccountId = accountRow.get('auth_account_id');

            const accessToken  = TokenService.generateAccessToken(authAccountId);
            const refreshToken = TokenService.generateRefreshToken(authAccountId);

            console.log(`[Auth] Signup complete: email=${email}, auth_account_id=${authAccountId}`);

            res.cookie('iam_adt', accessToken,  { ...COOKIE_OPTS, maxAge: 3_600 * 1000 });
            res.cookie('iam_bdt', refreshToken, { ...COOKIE_OPTS, maxAge: 30 * 24 * 3_600 * 1000 });

            return success(res, {
                auth_account: { auth_account_id: authAccountId, email },
                token: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 }
            });
        } catch (err) {
            console.error(`[Auth] Signup error: ${err.message}`);
            return fail(res, 500, 5000, err.message);
        }
    }

    async login(req, res) {
        try {
            const inputData = req.body?.input_data?.auth_account;
            if (!inputData) return fail(res, 400, 4000, 'Expected payload: { "input_data": { "auth_account": { "email": ..., "password": ... } } }');

            const { email, password } = inputData;
            if (!email || !password) return fail(res, 400, 4000, 'email and password are required');

            const sq = new SelectQueryImpl(Table.getTable('iam_auth_accounts'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'auth_account_id'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'email'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'password_hash'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'status'));
            sq.setCriteria(Criteria.eq(Column.getColumn('iam_auth_accounts', 'email'), email));

            // getOneRaw — iam_auth_accounts is a global IAM table, not range-scoped
            const accountRow = await dataAccess.getOneRaw(sq);
            if (!accountRow) return fail(res, 401, 4001, 'Invalid email or password');

            const status = accountRow.get('status');
            if (status !== 'active') return fail(res, 403, 4003, `Account is ${status}`);

            const isValid = await bcrypt.compare(password, accountRow.get('password_hash'));
            if (!isValid) return fail(res, 401, 4001, 'Invalid email or password');

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

            return success(res, {
                auth_account: { auth_account_id: authAccountId, email: accountRow.get('email') },
                token: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 }
            });
        } catch (err) {
            console.error(`[Auth] Login error: ${err.message}`);
            return fail(res, 500, 5000, err.message);
        }
    }

    async refresh(req, res) {
        try {
            const refreshTokenValue = req.body?.input_data?.token?.refresh_token;
            if (!refreshTokenValue) return fail(res, 400, 4000, 'Expected payload: { "input_data": { "token": { "refresh_token": "..." } } }');

            let decoded;
            try {
                decoded = TokenService.verifyToken(refreshTokenValue);
            } catch (err) {
                return fail(res, 401, 4001, 'Invalid or expired refresh token');
            }

            if (decoded.type !== 'refresh') return fail(res, 401, 4001, 'Invalid token type — expected refresh token');

            const authAccountId = parseInt(decoded.sub, 10);

            const sq = new SelectQueryImpl(Table.getTable('iam_auth_accounts'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'auth_account_id'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'status'));
            sq.setCriteria(Criteria.eq(Column.getColumn('iam_auth_accounts', 'auth_account_id'), authAccountId));

            // getOneRaw — global IAM table, no range context during refresh flow
            const accountRow = await dataAccess.getOneRaw(sq);
            if (!accountRow || accountRow.get('status') !== 'active') return fail(res, 401, 4001, 'Account not found or inactive');

            const accessToken = TokenService.generateAccessToken(authAccountId);
            res.cookie('iam_adt', accessToken, { ...COOKIE_OPTS, maxAge: 3_600 * 1000 });

            return success(res, {
                token: { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }
            });
        } catch (err) {
            console.error(`[Auth] Refresh error: ${err.message}`);
            return fail(res, 500, 5000, err.message);
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

            return success(res, { message: 'Logged out successfully' });
        } catch (err) {
            console.error(`[Auth] Logout error: ${err.message}`);
            return fail(res, 500, 5000, err.message);
        }
    }
}

module.exports = new AuthController();
