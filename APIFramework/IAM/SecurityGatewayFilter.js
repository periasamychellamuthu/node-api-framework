const TokenService  = require('./TokenService');
const dataAccess    = require('../Database/ORM/DataAccess');
const { SelectQueryImpl, Criteria, Column, Table } = require('../Database/QueryBuilder');

class SecurityGatewayFilter {

    static UI_PATHS = ['/', '/create-org'];

    static _blacklistCache     = new Map();
    static _accountStatusCache = new Map();
    static ACCOUNT_STATUS_TTL_MS = 60_000;

    static async handle(req, res, next) {
        const reqPath = req.path;

        let token = null;
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        } else if (req.cookies && req.cookies.iam_adt) {
            token = req.cookies.iam_adt;
        }

        if (!token) {
            return SecurityGatewayFilter._handleUnauthenticated(req, res, reqPath, 'No token provided');
        }

        let decoded;
        try {
            decoded = TokenService.verifyToken(token);
        } catch (err) {
            console.warn(`[SecurityGateway] Token verification failed: ${err.message}`);
            res.clearCookie('iam_adt', { path: '/' });
            res.clearCookie('iam_bdt', { path: '/' });
            return SecurityGatewayFilter._handleUnauthenticated(req, res, reqPath, 'Invalid or expired token');
        }

        const authAccountId = parseInt(decoded.sub, 10);
        const jti           = decoded.jti;

        const isBlacklisted = await SecurityGatewayFilter._isBlacklisted(jti);
        if (isBlacklisted) {
            console.warn(`[SecurityGateway] Blacklisted token jti=${jti} — account ${authAccountId}`);
            return res.status(401).json({
                response_status: { status_code: 4001, status: 'failed', message: 'Token has been revoked. Please log in again.' }
            });
        }

        const accountStatus = await SecurityGatewayFilter._getAccountStatus(authAccountId);
        if (!accountStatus) {
            return res.status(401).json({
                response_status: { status_code: 4001, status: 'failed', message: 'Account not found.' }
            });
        }
        if (accountStatus !== 'active') {
            return res.status(401).json({
                response_status: { status_code: 4001, status: 'failed', message: `Account is ${accountStatus}.` }
            });
        }

        req.authAccountId = authAccountId;
        console.log(`[SecurityGateway] Authenticated → auth_account_id=${authAccountId}`);
        next();
    }

    static async blacklistToken(jti, authAccountId, reason, expiresAt) {
        const expMs = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
        SecurityGatewayFilter._blacklistCache.set(jti, expMs);

        try {
            const dobj = dataAccess.constructDataObject();
            const row  = dataAccess.newRow('token_blacklist');
            row.set('jti',             jti);
            row.set('auth_account_id', authAccountId);
            row.set('reason',          reason);
            row.set('blacklisted_at',  new Date());
            row.set('expires_at',      new Date(expMs));
            dobj.addRow(row);
            await dataAccess.add(dobj);
        } catch (err) {
            console.error(`[SecurityGateway] Failed to persist token blacklist entry: ${err.message}`);
        }
    }

    static invalidateAccountStatusCache(authAccountId) {
        SecurityGatewayFilter._accountStatusCache.delete(authAccountId);
    }

    static async _isBlacklisted(jti) {
        const expMs = SecurityGatewayFilter._blacklistCache.get(jti);
        if (expMs !== undefined) {
            if (Date.now() < expMs) return true;
            SecurityGatewayFilter._blacklistCache.delete(jti);
            return false;
        }

        try {
            const sq = new SelectQueryImpl(Table.getTable('token_blacklist'));
            sq.setCriteria(
                Criteria.eq(Column.getColumn('token_blacklist', 'jti'), jti)
                    .and(Criteria.gt(Column.getColumn('token_blacklist', 'expires_at'), new Date()))
            );
            const row = await dataAccess.getOne(sq);
            if (row) {
                SecurityGatewayFilter._blacklistCache.set(jti, Date.now() + 3_600_000);
                return true;
            }
        } catch (err) {
            console.error(`[SecurityGateway] Blacklist DB check error: ${err.message}`);
        }

        return false;
    }

    static async _getAccountStatus(authAccountId) {
        const cached = SecurityGatewayFilter._accountStatusCache.get(authAccountId);
        if (cached && (Date.now() - cached.cachedAt) < SecurityGatewayFilter.ACCOUNT_STATUS_TTL_MS) {
            return cached.status;
        }

        try {
            const sq = new SelectQueryImpl(Table.getTable('iam_auth_accounts'));
            sq.addSelectColumn(Column.getColumn('iam_auth_accounts', 'status'));
            sq.setCriteria(Criteria.eq(Column.getColumn('iam_auth_accounts', 'auth_account_id'), authAccountId));
            const row = await dataAccess.getOne(sq);
            if (!row) return null;
            SecurityGatewayFilter._accountStatusCache.set(authAccountId, { status: row.get('status'), cachedAt: Date.now() });
            return row.get('status');
        } catch (err) {
            console.error(`[SecurityGateway] Account status DB check error: ${err.message}`);
            return null;
        }
    }

    static _handleUnauthenticated(req, res, reqPath, reason) {
        if (SecurityGatewayFilter.UI_PATHS.includes(reqPath)) {
            return res.redirect('/login');
        }
        return res.status(401).json({
            response_status: { status_code: 4001, status: 'failed', message: `Invalid user. Please login. (${reason})` }
        });
    }
}

module.exports = SecurityGatewayFilter;
