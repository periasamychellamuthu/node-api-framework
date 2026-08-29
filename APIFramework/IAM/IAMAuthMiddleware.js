const TokenService = require('./TokenService');

/**
 * IAMAuthMiddleware — Identity & Access Management layer.
 * 
 * Separate from XMLSecurityMiddleware (which handles URL whitelist, RBAC, template validation).
 * This middleware ONLY handles:
 *   1. JWT token verification (from Authorization header OR iam_adt cookie)
 *   2. Guest enforcement (block unauthenticated access)
 *   3. Building the credential object from JWT claims
 * 
 * Token resolution priority:
 *   1. Authorization: Bearer <token>    ← API clients (Postman, fetch, etc.)
 *   2. Cookie: iam_adt=<token>          ← Browser page navigations
 * 
 * Middleware chain order:
 *   CORS → Body Parse → Cookie Parse → [Public Routes] → IAMAuthMiddleware → XMLSecurityMiddleware → Entity Routes
 */
class IAMAuthMiddleware {

    /**
     * Public paths that guests can access without authentication.
     * Auth API routes and public UI (/login, /signup) are registered BEFORE
     * this middleware in main.js, so they don't need to be listed here.
     */
    static PUBLIC_PATHS = [
        '/favicon.ico'
    ];

    /**
     * UI paths that should redirect to /login instead of returning 401 JSON.
     */
    static UI_PATHS = [
        '/',
        '/create-tenant'
    ];

    /**
     * Express middleware function.
     */
    static handle(req, res, next) {
        const reqPath = req.path;

        // Allow public paths through without authentication
        if (IAMAuthMiddleware.PUBLIC_PATHS.includes(reqPath)) {
            req.$credentials = { userId: 'anonymous', accountId: null, email: null, roles: [], tenantId: null };
            return next();
        }

        // --- Token Extraction ---
        // Priority: Authorization header → iam_adt cookie
        let token = null;
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        } else if (req.cookies && req.cookies.iam_adt) {
            token = req.cookies.iam_adt;
        }

        if (!token) {
            return IAMAuthMiddleware._handleUnauthenticated(req, res, reqPath);
        }

        // --- Token Verification ---
        let decoded;
        try {
            decoded = TokenService.verifyToken(token);
        } catch (err) {
            console.warn(`[IAMAuth] Token verification failed: ${err.message}`);
            // Clear invalid cookies
            res.clearCookie('iam_adt', { path: '/' });
            res.clearCookie('iam_bdt', { path: '/' });
            return IAMAuthMiddleware._handleUnauthenticated(req, res, reqPath);
        }

        // --- Build Credentials ---
        const tenantHeader = req.headers['x-tenant-id'];
        const credentials = {
            accountId: decoded.sub,
            userId: decoded.sub,
            email: decoded.email,
            displayName: decoded.name,
            roles: decoded.roles || [],
            tenantId: decoded.tid || tenantHeader || null
        };

        req.$credentials = credentials;
        req.$currentUser = credentials.userId;
        req.$currentTenant = credentials.tenantId;

        console.log(`[IAMAuth] Authenticated -> Account: ${credentials.accountId}, Roles: [${credentials.roles.join(',')}], Tenant: ${credentials.tenantId}`);
        next();
    }

    /**
     * Handle unauthenticated requests:
     * - UI paths → redirect to /login
     * - API paths → 401 JSON response
     */
    static _handleUnauthenticated(req, res, reqPath) {
        // UI paths: redirect to login
        if (IAMAuthMiddleware.UI_PATHS.includes(reqPath)) {
            return res.redirect('/login');
        }

        // API paths: return 401
        return res.status(401).json({
            response_status: {
                status_code: 4001,
                status: 'failed',
                message: 'Invalid user. Please login.'
            }
        });
    }
}

module.exports = IAMAuthMiddleware;
