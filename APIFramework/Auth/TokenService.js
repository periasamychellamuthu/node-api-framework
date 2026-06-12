const jwt = require('jsonwebtoken');

// Secret key for signing JWTs. In production, load from environment variable.
const JWT_SECRET = process.env.JWT_SECRET || 'versatile-api-framework-secret-key-change-in-production';
const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY = '30d';

class TokenService {
    /**
     * Generate a short-lived access token.
     * JWT payload follows the structure from security-architecture.md:
     *   { sub: account_id, email, name, tid, roles, iat, exp }
     * 
     * @param {Object} account  - { id, email, display_name }
     * @param {number|null} tenantId - resolved tenant ID (null if no tenant yet)
     * @param {string[]} roles  - resolved from account_roles table
     */
    generateAccessToken(account, tenantId, roles) {
        return jwt.sign(
            {
                sub: account.id,
                email: account.email,
                name: account.display_name,
                tid: tenantId,
                roles: roles && roles.length > 0 ? roles : []
            },
            JWT_SECRET,
            { expiresIn: ACCESS_TOKEN_EXPIRY }
        );
    }

    /**
     * Generate a long-lived refresh token.
     */
    generateRefreshToken(account) {
        return jwt.sign(
            {
                sub: account.id,
                type: 'refresh'
            },
            JWT_SECRET,
            { expiresIn: REFRESH_TOKEN_EXPIRY }
        );
    }

    /**
     * Verify and decode a token. Returns decoded payload or throws.
     */
    verifyToken(token) {
        return jwt.verify(token, JWT_SECRET);
    }
}

module.exports = new TokenService();
