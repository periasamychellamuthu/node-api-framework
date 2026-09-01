// ─────────────────────────────────────────────────────────────────────────────
// Versatile Platform — Entry Point
// Architecture reference: architecture-knowledge-base.md §1, §12
//
// Middleware order (3-layer filter chain):
//
//   [Public UI + Auth routes]    ← no auth required
//       ↓
//   SecurityGatewayFilter        ← Layer 1: "Who are you?" (JWT verify + blacklist + status)
//       ↓
//   OrgContextFilter             ← Layer 2: "Which org?" (org resolution + range injection)
//       ↓
//   APIRequestValidator          ← Input whitelisting from security XML
//       ↓
//   RBACMiddleware (per-route)   ← Layer 3: "What can you do?" (permission check)
//       ↓
//   Route Handlers               ← Framework auto-appends range scoping on every query
// ─────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const cookieParser = require('cookie-parser');

// ── Step 1: Create Express app ───────────────────────────────────────────────
const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Step 2: Load entity configs into memory (sync — must be before boot async)
const EntityConfigLoader = require('./APIFramework/Registry/EntityConfigLoader');
try {
    EntityConfigLoader.loadAll();
} catch (err) {
    console.error('[Versatile] FATAL — Step 2 (EntityConfigLoader.loadAll) failed. Check src/entities/*.json for malformed JSON.');
    console.error(err);
    process.exit(1);
}

const DataDictionaryParser = require('./APIFramework/Registry/DataDictionaryParser');
const SchemaBuilder        = require('./APIFramework/Database/SchemaBuilder');
const DBConnectionPool     = require('./APIFramework/Database/DBConnectionPool');

// ── Async Boot Sequence ──────────────────────────────────────────────────────
(async () => {
    // Step 3: Initialise DB connection pool — MUST happen before any DB call
    try {
        await DBConnectionPool.init();
    } catch (err) {
        console.error('[Versatile] FATAL — Step 3 (DBConnectionPool.init) failed. Check product-config.json DB credentials and that MySQL is reachable.');
        console.error(err);
        process.exit(1);
    }

    // Step 4: Parse data dictionaries — framework (APIFramework/schema) + product (src/schema).
    //   Both DD XMLs are loaded before any schema or ORM work so that every table
    //   definition (framework IAM + product) is available in a single pass.
    try {
        await DataDictionaryParser.parseDataDictionaries(
            path.join(__dirname, 'APIFramework', 'schema'),
            path.join(__dirname, 'src', 'schema')
        );
    } catch (err) {
        console.error('[Versatile] FATAL — Step 4 (DataDictionaryParser.parseDataDictionaries) failed.');
        console.error(err);
        process.exit(1);
    }

    // Step 5: Populate ORM SchemaRegistry from the parsed DD definitions.
    //   Must run AFTER parseDataDictionaries() and BEFORE any DataAccess/DataModel calls.
    try {
        const schemaRegistry = require('./APIFramework/Database/ORM/SchemaRegistry');
        schemaRegistry.loadFromDataDictionary();
    } catch (err) {
        console.error('[Versatile] FATAL — Step 5 (SchemaRegistry.loadFromDataDictionary) failed.');
        console.error(err);
        process.exit(1);
    }

    // Step 6: Sync ALL tables from data dictionary (framework + product) in one pass.
    //   CREATE TABLE IF NOT EXISTS for every table declared in DD XML, with proper
    //   AUTO_INCREMENT, DEFAULT, UNIQUE, FK constraints, and secondary indexes.
    //   No DDL is hardcoded — SchemaBuilder reads directly from DataDictionaryParser.
    try {
        await SchemaBuilder.syncSchema();
    } catch (err) {
        console.error('[Versatile] FATAL — Step 6 (SchemaBuilder.syncSchema) failed.');
        console.error(err);
        process.exit(1);
    }

    // Step 6b: Apply seed rows declared via <seed> in DD XML (e.g. id_range_allocator 'global' row).
    try {
        await SchemaBuilder.seedFrameworkData();
    } catch (err) {
        console.error('[Versatile] FATAL — Step 6b (SchemaBuilder.seedFrameworkData) failed.');
        console.error(err);
        process.exit(1);
    }

    // Step 7: Warm SequenceGenerator in-memory counters from persisted org_id_ranges.
    //   Resumes each org's counter from the last flushed current_val after a restart.
    try {
        await SchemaBuilder.warmSequenceGenerator();
    } catch (err) {
        console.error('[Versatile] FATAL — Step 7 (SchemaBuilder.warmSequenceGenerator) failed. Could not warm sequence counters from org_id_ranges.');
        console.error(err);
        process.exit(1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Route + Middleware Registration
    //
    // Rule: Everything registered BEFORE SecurityGatewayFilter is public (no auth).
    //       Everything registered AFTER SecurityGatewayFilter needs a valid JWT.
    // ─────────────────────────────────────────────────────────────────────────

    const publicDir = path.join(__dirname, 'public');

    // ── Step 8: Public UI Pages — no auth required ───────────────────────────
    app.get('/login',       (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
    app.get('/signup',      (req, res) => res.sendFile(path.join(publicDir, 'signup.html')));
    // DEV ONLY — remove before production
    app.get('/dev-console', (req, res) => res.sendFile(path.join(publicDir, 'dev-console.html')));

    // ── Step 9: Public Auth API Routes — no auth required ────────────────────
    const AuthController = require('./APIFramework/IAM/AuthController');
    app.post('/auth/signup',  AuthController.signup.bind(AuthController));
    app.post('/auth/login',   AuthController.login.bind(AuthController));
    app.post('/auth/refresh', AuthController.refresh.bind(AuthController));

    // ── Step 10: SecurityGatewayFilter — Layer 1 (JWT verify + blacklist + account status)
    //   All routes registered below this line require a valid, non-blacklisted JWT.
    const SecurityGatewayFilter = require('./APIFramework/IAM/SecurityGatewayFilter');
    app.use(SecurityGatewayFilter.handle);

    // ── Step 11: Authenticated Auth Routes ───────────────────────────────────
    //   These need an authenticated user but no org context (no OrgContextFilter needed).
    const OrgCreationHandler = require('./APIFramework/Handler/OrgCreationHandler');
    app.post('/auth/logout',  AuthController.logout.bind(AuthController));
    app.post('/api/v1/orgs',  OrgCreationHandler.createOrg.bind(OrgCreationHandler));

    // ── Step 12: Authenticated UI Pages ──────────────────────────────────────
    app.get('/',         (req, res) => res.sendFile(path.join(publicDir, 'home.html')));
    app.get('/create-org', (req, res) => res.sendFile(path.join(publicDir, 'create-org.html')));

    // ── Step 13: OrgContextFilter — Layer 2 (org resolution + range injection)
    //   Applies only to /org/:orgHandle/* routes.
    //   For non-org routes it calls next() immediately.
    const OrgContextFilter = require('./APIFramework/IAM/OrgContextFilter');
    app.use(OrgContextFilter.handle);

    // ── Step 14: APIRequestValidator (Security XML input whitelisting) ────────
    //   Validates input_data against security XML templates.
    //   Only active for org-scoped product routes (defined in security-config/security-api.xml).
    const XMLSecurityMiddleware = require('./APIFramework/Security/XMLSecurityMiddleware');
    app.use(XMLSecurityMiddleware.validate.bind(XMLSecurityMiddleware));

    // ── Step 15: Entity API Routes ────────────────────────────────────────────
    //   Dynamically mounted from security-config/security-api.xml.
    //   RBACMiddleware.enforce(resource, action) is wired per-route inside
    //   DefaultRouterHandler based on the entity config operations[] roles array.
    try {
        const XMLRouteLoader = require('./APIFramework/API/XMLRouteRegistrationLoader');
        await XMLRouteLoader.registerRoutes(app);
    } catch (err) {
        console.error('[Versatile] FATAL — Step 15 (XMLRouteLoader.registerRoutes) failed. Check security-config/security-api.xml for malformed entries.');
        console.error(err);
        process.exit(1);
    }

    // ── Start HTTPS Server ────────────────────────────────────────────────────
    const certsDir = path.join(__dirname, 'certs');
    let serverOptions;
    try {
        serverOptions = {
            key:  fs.readFileSync(path.join(certsDir, 'key.pem')),
            cert: fs.readFileSync(path.join(certsDir, 'cert.pem'))
        };
    } catch (err) {
        console.error(`[Versatile] FATAL — Could not read TLS cert/key from ${certsDir}. Generate them or check the certs/ directory.`);
        console.error(err);
        process.exit(1);
    }

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
        console.log('[Versatile] Middleware chain: SecurityGatewayFilter → OrgContextFilter → APIRequestValidator → RBACMiddleware → Handler');
    });

    // Graceful shutdown — flush sequence counters + release port
    const shutdown = async (signal) => {
        console.log(`\n[Versatile] ${signal} received — shutting down gracefully...`);

        // Flush in-memory sequence counters to DB before exit (minimise gaps)
        try {
            const SequenceGenerator = require('./APIFramework/Database/SequenceGenerator');
            await SequenceGenerator.flushNow();
            console.log('[Versatile] Sequence counters flushed.');
        } catch (e) {
            console.error('[Versatile] Sequence flush error on shutdown:', e.message);
        }

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
})().catch((err) => {
    // Safety net — catches anything not already handled by a step-specific
    // try/catch above (e.g. a bug in the boot sequence itself). Without this,
    // nodemon/node would report a bare "app crashed" with no context.
    console.error('[Versatile] FATAL — unhandled error during server startup:');
    console.error(err);
    process.exit(1);
});

// Belt-and-braces: catch any stray unhandled rejection or exception that
// occurs outside the boot IIFE (e.g. in async event handlers registered
// during boot) so the process always logs context before exiting.
process.on('unhandledRejection', (reason) => {
    console.error('[Versatile] FATAL — unhandled promise rejection:');
    console.error(reason);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('[Versatile] FATAL — uncaught exception:');
    console.error(err);
    process.exit(1);
});
