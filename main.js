
//Automatically create server through express module
var server = require('./src/server/https/main');

var router = require('./APIFramework/DefaultRouterHandler');

// Ignore the browser's favicon requests
server.application.get('/favicon.ico', (req, res) => res.status(204).end());

const EntityConfigLoader = require('./APIFramework/Configuration/EntityConfigLoader');
EntityConfigLoader.loadAll(); // Caches entity configurations at boot

const DataDictionaryParser = require('./APIFramework/Configuration/DataDictionaryParser');
const SchemaBuilder = require('./APIFramework/Database/SchemaBuilder');
const path = require('path');

// Asynchronous boot sequence resolving configurations before running traffic
(async () => {
    await DataDictionaryParser.parseDataDictionaries(path.join(__dirname, 'conf'));
    await SchemaBuilder.syncSchema();

    // ───────────────────────────────────────────────────────────────
    // Middleware Chain (order matters per security architecture):
    //
    //   1. CORS + Body Parse           (in src/server/https/main.js)
    //   2. UI Pages (public)           (static HTML, no auth needed)
    //   3. Auth API Routes (public)    (/auth/signup, /auth/login, /auth/refresh)
    //   4. IAMAuthMiddleware           (JWT verify + guest enforcement)
    //   5. Auth Protected Routes       (/auth/link-tenant — needs auth)
    //   6. XMLSecurityMiddleware       (URL whitelist, RBAC, template validation)
    //   7. Entity API Routes           (registered from security-api.xml)
    // ───────────────────────────────────────────────────────────────

    // --- Step 2: Public UI Pages (no auth required) ---
    const publicDir = path.join(__dirname, 'public');
    server.application.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
    server.application.get('/signup', (req, res) => res.sendFile(path.join(publicDir, 'signup.html')));

    // --- Step 3: Auth API Routes (public, no auth) ---
    const AuthController = require('./APIFramework/Auth/AuthController');
    server.application.post('/auth/signup', AuthController.signup.bind(AuthController));
    server.application.post('/auth/login', AuthController.login.bind(AuthController));
    server.application.post('/auth/refresh', AuthController.refresh.bind(AuthController));
    server.application.get('/auth/logout', (req, res) => {
        res.clearCookie('iam_adt', { path: '/' });
        res.clearCookie('iam_bdt', { path: '/' });
        res.redirect('/login');
    });

    // --- Step 4: IAMAuthMiddleware (JWT from header OR cookie) ---
    // Everything below this line requires a valid access token.
    // Token is read from: Authorization header (API clients) → iam_adt cookie (browser).
    // Unauthenticated UI requests → redirect to /login.
    // Unauthenticated API requests → 401 JSON.
    const IAMAuthMiddleware = require('./APIFramework/Middleware/IAMAuthMiddleware');
    server.application.use(IAMAuthMiddleware.handle);

    // --- Step 5: Authenticated UI Pages (server-side enforced via cookie) ---
    server.application.get('/', (req, res) => res.sendFile(path.join(publicDir, 'home.html')));
    server.application.get('/create-tenant', (req, res) => res.sendFile(path.join(publicDir, 'create-tenant.html')));

    // --- Step 6: Auth Protected API Routes (need auth, but before XMLSecurity) ---
    server.application.post('/auth/link-tenant', AuthController.linkTenant.bind(AuthController));
    server.application.post('/api/v1/create-tenant', AuthController.createTenant.bind(AuthController));

    // --- Step 6: XMLSecurityMiddleware ---
    const XMLSecurityMiddleware = require('./APIFramework/Middleware/XMLSecurityMiddleware');
    server.application.use(XMLSecurityMiddleware.validate.bind(XMLSecurityMiddleware));

    // --- Step 7: Entity API Routes (from security-api.xml) ---
    const XMLRouteLoader = require('./APIFramework/API/XMLRouteRegistrationLoader');
    await XMLRouteLoader.registerRoutes(server.application);
})();