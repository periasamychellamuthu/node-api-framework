const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Secret key for signing JWTs. Always set JWT_SECRET in production env.
const JWT_SECRET = process.env.JWT_SECRET || 'versatile-api-framework-secret-key-change-in-production';
const ACCESS_TOKEN_EXPIRY  = '1h';
const REFRESH_TOKEN_EXPIRY = '30d';

/**
 * TokenService — IAM JWT lifecycle.
 *
 * JWT Design (finalized — architecture-knowledge-base.md §3):
 *   Access token payload:  { sub, iat, exp, jti }
 *   Refresh token payload: { sub, iat, exp, jti, type:'refresh' }
 *
 * NOTHING product-specific (roles, org list, tid, email) goes in the token.
 * All org context is resolved per-request from the URL by OrgContextFilter.
 * All role/permission data is resolved per-request from DB/cache by RBACMiddleware.
 *
 * sub  = auth_account_id (immutable, IAM-owned)
 * jti  = unique token ID (UUID v4) — used by SecurityGatewayFilter for blacklist lookup
 */
class TokenService {

    /**
     * Generate a short-lived access token.
     * @param {number} authAccountId  — from iam_auth_accounts.auth_account_id
     * @returns {string} signed JWT
     */
    generateAccessToken(authAccountId) {
        const jti = crypto.randomUUID();
        return jwt.sign(
            { jti },
            JWT_SECRET,
            {
                subject: String(authAccountId),
                expiresIn: ACCESS_TOKEN_EXPIRY
            }
        );
    }

    /**
     * Generate a long-lived refresh token.
     * @param {number} authAccountId  — from iam_auth_accounts.auth_account_id
     * @returns {string} signed JWT
     */
    generateRefreshToken(authAccountId) {
        const jti = crypto.randomUUID();
        return jwt.sign(
            { jti, type: 'refresh' },
            JWT_SECRET,
            {
                subject: String(authAccountId),
                expiresIn: REFRESH_TOKEN_EXPIRY
            }
        );
    }

    /**
     * Verify and decode a token.
     * Returns decoded payload { sub, iat, exp, jti } or throws on invalid/expired.
     * @param {string} token
     * @returns {object} decoded payload
     */
    verifyToken(token) {
        return jwt.verify(token, JWT_SECRET);
    }

    /**
     * Decode a token without verification.
     * Used only for extracting jti/exp from an already-verified token (e.g. logout blacklisting).
     * @param {string} token
     * @returns {object|null}
     */
    decodeToken(token) {
        return jwt.decode(token);
    }
}

module.exports = new TokenService();
