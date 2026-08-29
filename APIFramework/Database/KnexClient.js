const knex = require('knex');
const fs   = require('fs');
const path = require('path');

/**
 * KnexClient — Single shared Knex.js instance for all entity CRUD operations.
 *
 * Why Knex?
 *   - Replaces manual INSERT/UPDATE/DELETE SQL string construction in PreDefaultEntityHandler.
 *   - Replaces the custom SelectQuery + DBUtils.getSelectQueryAsSQL() pipeline for SELECT queries.
 *   - Knex builds fully parameterized SQL — no string concatenation, no injection risk.
 *   - Chainable API maps 1:1 to our query patterns:
 *       getList   → knex(table).whereBetween(pk, [start, end])
 *       getEntity → knex(table).where(pk, id).whereBetween(pk, [start, end]).first()
 *       add       → knex(table).insert(data)
 *       edit      → knex(table).where(pk, id).update(data)
 *       delete    → knex(table).where(pk, id).delete()
 *
 * What this does NOT replace:
 *   - DBConnectionPool (still used by SequenceGenerator, SchemaBuilder, AuthController
 *     for raw transactional SQL that requires explicit connection management).
 *   - SequenceGenerator (uses DBConnectionPool.withConnection for atomic range ops).
 *   - SchemaBuilder (DDL — CREATE TABLE — stays raw SQL).
 *
 * Config is read from product-config.json at project root.
 * Knex manages its own internal connection pool (min: 2, max: 50).
 *
 * mysql2 is used as the underlying driver — it is already installed in this project
 * via the "mysql": "npm:mysql2@^2.3.3" alias in package.json.
 */

function loadConfig() {
    try {
        const configPath = path.join(process.cwd(), 'product-config.json');
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
    } catch (e) {
        console.error('[KnexClient] Failed to load product-config.json:', e.message);
    }
    return {};
}

const config = loadConfig();

const client = knex({
    client: 'mysql2',
    connection: {
        host:        config.host     || 'localhost',
        port:        parseInt(config.port, 10) || 3306,
        user:        config.user     || 'root',
        password:    config.password || '',
        database:    config.dataspace || 'versatile',
        // Tell mysql2 to receive DATE/DATETIME/TIMESTAMP columns as strings
        // rather than converting them to JS Date objects (which toString() wrong).
        dateStrings: true
    },
    pool: {
        min: 2,
        max: 50
    }
});

module.exports = client;
