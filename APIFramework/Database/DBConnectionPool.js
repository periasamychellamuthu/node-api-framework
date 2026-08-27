const mysql = require('mysql');
const fs = require('fs');
const path = require('path');

/**
 * DBConnectionPool — MySQL connection pool manager.
 *
 * Replaces the legacy src/database/MYSQL/connect.js (which used node-querybuilder).
 * This class manages a plain mysql2-compatible connection pool.
 *
 * DB config is read from product-config.json at project root (host, port, user, password, dataspace).
 */
class DBConnectionPool {
    constructor() {
        this.pool = null;
        this._config = this._loadConfig();
    }

    _loadConfig() {
        try {
            const configPath = path.join(process.cwd(), 'product-config.json');
            if (fs.existsSync(configPath)) {
                return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
        } catch (e) {
            console.error('[DBConnectionPool] Failed to load product-config.json:', e.message);
        }
        return {};
    }

    /**
     * Initialises the connection pool.
     * Creates the database if it doesn't exist, then establishes the pool.
     * Must be called once at boot (from main.js / SchemaBuilder).
     */
    async init() {
        if (this.pool) {
            console.log('[DBConnectionPool] Pool already initialised.');
            return this.pool;
        }

        const { host, port, user, password, dataspace } = this._config;
        const dbName = dataspace || 'versatile';

        const portNum = parseInt(port, 10) || 3306;

        return new Promise((resolve, reject) => {
            // Step 1: Create DB if absent using a temporary single connection.
            // We call tempConn.end() ONLY on success (connection alive).
            // On error we call tempConn.destroy() because the connection may already be dead
            // (e.g. timeout / network error closes it before our callback runs).
            const tempConn = mysql.createConnection({ host, user, password, port: portNum });

            tempConn.connect((connectErr) => {
                if (connectErr) {
                    console.error('[DBConnectionPool] Cannot connect to MySQL server:', connectErr.message);
                    console.error('[DBConnectionPool] Check: MySQL is running, and product-config.json has correct host/port/user/password.');
                    tempConn.destroy();
                    return reject(connectErr);
                }

                tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``, (err) => {
                    if (err) {
                        console.error('[DBConnectionPool] Failed to create database:', err.message);
                        tempConn.destroy(); // destroy — don't call end() on a potentially dead connection
                        return reject(err);
                    }

                    tempConn.end(); // connection is alive here — safe to end gracefully

                    // Step 2: Create the pool bound to the actual DB
                    this.pool = mysql.createPool({
                        host,
                        user,
                        password,
                        database: dbName,
                        port: portNum,
                        connectionLimit: 50
                    });

                    // Step 3: Verify at least one connection works
                    this.pool.getConnection((err, connection) => {
                        if (err) {
                            console.error('[DBConnectionPool] Pool connection test failed:', err.message);
                            return reject(err);
                        }
                        connection.release();
                        console.log(`[DBConnectionPool] Pool ready on database '${dbName}'`);
                        resolve(this.pool);
                    });
                });
            });
        });
    }

    /**
     * Execute a parameterised query. Returns a Promise.
     */
    query(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.pool) return reject(new Error('[DBConnectionPool] Pool not initialised. Call init() first.'));
            this.pool.query(sql, params, (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });
    }

    /**
     * Acquire a connection from the pool, execute fn(connection), then release the
     * connection automatically — whether fn resolves or rejects.
     *
     * Usage:
     *   const result = await DBConnectionPool.withConnection(async (conn) => {
     *       // use conn.query / conn.beginTransaction / conn.commit / conn.rollback
     *       return someValue;
     *   });
     *
     * Callers must NOT call connection.release() themselves — it is handled here.
     */
    withConnection(fn) {
        return new Promise((resolve, reject) => {
            if (!this.pool) return reject(new Error('[DBConnectionPool] Pool not initialised. Call init() first.'));
            this.pool.getConnection((err, connection) => {
                if (err) return reject(err);
                //promiseA.then(onFulfilled).then(onFulfilled2).catch(onRejected). onFulfilled - current promise fulfilled. onFulfilled2 - function call fulfilled , onRejected - function call rejected/exception.
                // reject() ends the promise and land in catch section but it is not exactly like exception.
                Promise.resolve()
                    .then(() => fn(connection))
                    .then((result) => {
                        connection.release();
                        resolve(result);
                    })
                    .catch((fnErr) => {
                        connection.release();
                        reject(fnErr);
                    });
            });
        });
    }
}

module.exports = new DBConnectionPool();
