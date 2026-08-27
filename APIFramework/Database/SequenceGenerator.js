const SQLConnect = require('./DBConnectionPool');

const TENANT_CAPACITY_BUFFER = 1000000000; // 1 Billion records natively available per tenant per generator

class SequenceGenerator {
    static TENANT_RANGES = {};
    
    /**
     * Resolves the latest unique value exclusively identifying bounds across explicit Tenanted PK mapping.
     */
    static async getNextId(tenantId, generatorName) {
        if (!tenantId) {
            throw new Error("[SequenceGenerator] Tenant ID is explicitly required for unique generation mapping bounds.");
        }
        if (!generatorName) {
            throw new Error("[SequenceGenerator] Generator name is required (e.g., 'users.id').");
        }

        // Use withConnection so the connection is always released when the work is done.
        return SQLConnect.withConnection((connection) => {
            return new Promise((resolve, reject) => {

                // Helper: promisify connection.query
                const query = (sql, params) => new Promise((res, rej) => {
                    connection.query(sql, params, (err, rows) => err ? rej(err) : res(rows));
                });

                // Helper: promisify connection.beginTransaction / commit / rollback
                const beginTransaction = () => new Promise((res, rej) => {
                    connection.beginTransaction(err => err ? rej(err) : res());
                });
                const commit = () => new Promise((res, rej) => {
                    connection.commit(err => err ? rej(err) : res());
                });
                const rollback = () => new Promise((res) => {
                    connection.rollback(() => res()); // always resolves — swallow rollback errors
                });

                (async () => {
                    await beginTransaction();
                    try {
                        // 1. Lock the sequence row to prevent race conditions. Used FOR UPDATE in the sql query for locking in DB level
                        const results = await query(
                            `SELECT current_value, range_min, range_max FROM platform_sequences WHERE tenant_id = ? AND generator_name = ? FOR UPDATE`,
                            [tenantId, generatorName]
                        );

                        let nextVal;

                        if (results.length > 0) {
                            // Row exists — bump current_value
                            const currentVal = parseInt(results[0].current_value, 10);
                            const maxVal     = parseInt(results[0].range_max, 10);
                            nextVal          = currentVal + 1;

                            if (nextVal > maxVal) {
                                throw new Error(`[SequenceGenerator] Tenant ${tenantId} exceeded capacity on ${generatorName}`);
                            }

                            SequenceGenerator.TENANT_RANGES[tenantId + '_' + generatorName] = {
                                min: parseInt(results[0].range_min, 10),
                                max: maxVal
                            };

                            await query(
                                `UPDATE platform_sequences SET current_value = ? WHERE tenant_id = ? AND generator_name = ?`,
                                [nextVal, tenantId, generatorName]
                            );

                        } else {
                            // First time this tenant uses this generator — allocate a fresh range
                            const maxRes = await query(
                                `SELECT MAX(range_max) as highest_range FROM platform_sequences WHERE generator_name = ?`,
                                [generatorName]
                            );

                            const highestRange = (maxRes.length > 0 && maxRes[0].highest_range)
                                ? parseInt(maxRes[0].highest_range, 10)
                                : 0;

                            const newMin = highestRange + 1;
                            const newMax = highestRange + TENANT_CAPACITY_BUFFER;
                            nextVal      = newMin;

                            SequenceGenerator.TENANT_RANGES[tenantId + '_' + generatorName] = { min: newMin, max: newMax };

                            await query(
                                `INSERT INTO platform_sequences (tenant_id, generator_name, current_value, range_min, range_max) VALUES (?, ?, ?, ?, ?)`,
                                [tenantId, generatorName, nextVal, newMin, newMax]
                            );
                        }

                        await commit();
                        resolve(nextVal);

                    } catch (err) {
                        await rollback();
                        reject(err);
                    }
                })();
            });
        });
    }

}

module.exports = SequenceGenerator;
