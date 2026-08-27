
// ─────────────────────────────────────────────────────────────────────────────
// Versatile Platform — Entry Point
// Boot order follows KB: server-framework/startup-boot-sequence.md
// ─────────────────────────────────────────────────────────────────────────────

var express = require('express');
var https   = require('https');
var fs      = require('fs');
var path    = require('path');
var cookieParser = require('cookie-parser');

// ── Step 1: Create Express app ───────────────────────────────────────────────
var app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, authorization, x-tenant-id');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());    //populating JSON payload request data to req.body when content-Type : application/json
app.use(express.urlencoded({ extended: true })); // e.g.HTML form submissions via POST body "name=John&age=30" → req.body = { name: 'John', age: '30' }
app.use(cookieParser());    //populating cookies header into req.cookies
app.get('/favicon.ico', (req, res) => res.status(204).end());
//Called by browser to render icon in browser tab, bookmark, history. Returned 204 : request succeeded, but there's no body to return

// ── Step 2: Load entity configs into memory (sync — must be before boot async) 
const EntityConfigLoader = require('./APIFramework/Registry/EntityConfigLoader');
EntityConfigLoader.loadAll();

const DataDictionaryParser = require('./APIFramework/Registry/DataDictionaryParser');   //return singleton instance
const SchemaBuilder        = require('./APIFramework/Database/SchemaBuilder');

const DBConnectionPool = require('./APIFramework/Database/DBConnectionPool');

// ── Async Boot Sequence ──────────────────────────────────────────────────────
(async () => {
    // Step 3: Initialise DB connection pool — MUST happen before any DB call
    await DBConnectionPool.init();

    // Step 4: Parse data dictionary (src/schema/data-dictionary.xml)
    await DataDictionaryParser.parseDataDictionaries(path.join(__dirname, 'src', 'schema'));

    // Step 5: Sync DB schema (CREATE TABLE IF NOT EXISTS for all DD-defined tables)
    await SchemaBuilder.syncSchema();

    // ─────────────────────────────────────────────────────────────────────────
    // Middleware Chain (order matters — see security-architecture.md):
    //   1. CORS + Body Parse          (above, before async block)
    //   2. Public UI pages            (no auth needed)
    //   3. Public Auth API routes     (/auth/signup, /auth/login, /auth/refresh)
    //   4. IAMAuthMiddleware          (JWT verify — everything below needs a token)
    //   5. Authenticated UI pages     (served after auth check)
    //   6. Auth-protected API routes  (/auth/link-tenant, /api/v1/create-tenant)
    //   7. XMLSecurityMiddleware      (URL whitelist + role + template validation)
    //   8. Entity API routes          (registered from security-config/security-api.xml)
    // ─────────────────────────────────────────────────────────────────────────

    const publicDir = path.join(__dirname, 'public');

    // Step 6: Public UI Pages (no auth required)
    app.get('/login',       (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
    app.get('/signup',      (req, res) => res.sendFile(path.join(publicDir, 'signup.html')));
    // DEV ONLY — remove before production
    app.get('/dev-console', (req, res) => res.sendFile(path.join(publicDir, 'dev-console.html')));

    // Step 7: Public Auth API Routes
    const AuthController = require('./APIFramework/Auth/AuthController');
    app.post('/auth/signup',  AuthController.signup.bind(AuthController));
    app.post('/auth/login',   AuthController.login.bind(AuthController));
    app.post('/auth/refresh', AuthController.refresh.bind(AuthController));
    app.get('/auth/logout', (req, res) => {
        res.clearCookie('iam_adt', { path: '/' });
        res.clearCookie('iam_bdt', { path: '/' });
        res.redirect('/login');
    });

    // Step 8: IAMAuthMiddleware — JWT verification gate
    const IAMAuthMiddleware = require('./APIFramework/Security/IAMAuthMiddleware');
    app.use(IAMAuthMiddleware.handle);

    // Step 9: Authenticated UI Pages (requires valid token via cookie)
    app.get('/',              (req, res) => res.sendFile(path.join(publicDir, 'home.html')));
    app.get('/create-tenant', (req, res) => res.sendFile(path.join(publicDir, 'create-tenant.html')));

    // Step 10: Auth-protected API routes (need auth, registered before XMLSecurity)
    app.post('/auth/link-tenant',       AuthController.linkTenant.bind(AuthController));
    app.post('/api/v1/create-tenant',   AuthController.createTenant.bind(AuthController));

    // Step 11: XMLSecurityMiddleware — URL whitelist + role + input_data template validation
    const XMLSecurityMiddleware = require('./APIFramework/Security/XMLSecurityMiddleware');
    app.use(XMLSecurityMiddleware.validate.bind(XMLSecurityMiddleware));

    // Step 12: Entity API Routes (dynamically mounted from security-config/security-api.xml)
    const XMLRouteLoader = require('./APIFramework/API/XMLRouteRegistrationLoader');
    await XMLRouteLoader.registerRoutes(app);

    // ── Start HTTPS Server ───────────────────────────────────────────────────
    const certsDir = path.join(__dirname, 'certs');
    const serverOptions = {
        key:  fs.readFileSync(path.join(certsDir, 'key.pem')),
        cert: fs.readFileSync(path.join(certsDir, 'cert.pem'))
    };

    const PORT   = process.env.PORT || 3000;
    const server = https.createServer(serverOptions, app);

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[Versatile] Port ${PORT} is already in use.`);
            console.error(`[Versatile] Kill the old process with:  kill $(lsof -ti :${PORT})`);
            process.exit(1);
        } else {
            throw err;
        }
    });

    server.listen(PORT, () => {
        console.log(`[Versatile] Server running on https://localhost:${PORT}`);
    });

    // Graceful shutdown — release the port on Ctrl+C or process kill
    const shutdown = (signal) => {
        console.log(`\n[Versatile] ${signal} received — shutting down gracefully...`);
        server.close(() => {
            console.log('[Versatile] HTTP server closed. Exiting.');
            process.exit(0);
        });
        // Force-exit if server.close() hangs for more than 5s
        setTimeout(() => {
            console.error('[Versatile] Forced exit after timeout.');
            process.exit(1);
        }, 5000).unref();
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
})();
