const SQLConnect = require('../../src/database/MYSQL/connect');

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

        // Fast transaction mapping locking records automatically 
        return new Promise((resolve, reject) => {
            SQLConnect.pool.getConnection((err, connection) => {
                if (err) return reject(err);

                connection.beginTransaction((err) => {
                    if (err) {
                        connection.release();
                        return reject(err);
                    }

                    // 1. Lock Row Explicitly to prevent Race-Conditions avoiding overlaps 
                    const lockQuery = `SELECT current_value, range_min, range_max FROM platform_sequences WHERE tenant_id = ? AND generator_name = ? FOR UPDATE`;
                    
                    connection.query(lockQuery, [tenantId, generatorName], (err, results) => {
                        if (err) {
                            connection.rollback(() => connection.release());
                            return reject(err);
                        }

                        if (results.length > 0) {
                            // Row exists, bump current_value intelligently!
                            const currentVal = parseInt(results[0].current_value, 10);
                            const maxVal = parseInt(results[0].range_max, 10);
                            const nextVal = currentVal + 1;

                            if (nextVal > maxVal) {
                                connection.rollback(() => connection.release());
                                return reject(new Error(`[SequenceGenerator] Tenant ${tenantId} exceeded allocated generator capacity on ${generatorName}`));
                            }
                            
                            SequenceGenerator.TENANT_RANGES[tenantId + '_' + generatorName] = { 
                                min: parseInt(results[0].range_min, 10), 
                                max: maxVal 
                            };

                            const updateQuery = `UPDATE platform_sequences SET current_value = ? WHERE tenant_id = ? AND generator_name = ?`;
                            connection.query(updateQuery, [nextVal, tenantId, generatorName], (err) => {
                                if (err) {
                                    connection.rollback(() => connection.release());
                                    return reject(err);
                                }
                                connection.commit((err) => {
                                    if (err) {
                                        connection.rollback(() => connection.release());
                                        return reject(err);
                                    }
                                    connection.release();
                                    resolve(nextVal);
                                });
                            });

                        } else {
                            // First time tenant interacts with table!
                            // Map their absolute physical bounds algorithmically off the biggest tenant!
                            const maxBoundQuery = `SELECT MAX(range_max) as highest_range FROM platform_sequences WHERE generator_name = ?`;
                            connection.query(maxBoundQuery, [generatorName], (err, maxRes) => {
                                if (err) {
                                    connection.rollback(() => connection.release());
                                    return reject(err);
                                }

                                let highestRange = 0;
                                if (maxRes.length > 0 && maxRes[0].highest_range) {
                                    highestRange = parseInt(maxRes[0].highest_range, 10);
                                }

                                const newMin = highestRange + 1;
                                const newMax = highestRange + TENANT_CAPACITY_BUFFER;
                                const nextVal = newMin;

                                SequenceGenerator.TENANT_RANGES[tenantId + '_' + generatorName] = { min: newMin, max: newMax };

                                const insertQuery = `INSERT INTO platform_sequences (tenant_id, generator_name, current_value, range_min, range_max) VALUES (?, ?, ?, ?, ?)`;
                                connection.query(insertQuery, [tenantId, generatorName, nextVal, newMin, newMax], (err) => {
                                    if (err) {
                                        connection.rollback(() => connection.release());
                                        return reject(err);
                                    }

                                    connection.commit((err) => {
                                        if (err) {
                                            connection.rollback(() => connection.release());
                                            return reject(err);
                                        }
                                        connection.release();
                                        resolve(nextVal);
                                    });
                                });
                            });
                        }
                    });
                });
            });
        });
    }

    /**
     * Resolves the configured ID boundary mapping inherently checking DB structures cleanly without incrementing.
     */
    static async ensureTenantRange(tenantId, generatorName) {
        if (!tenantId || !generatorName) return null;
        const cacheKey = tenantId + '_' + generatorName;
        if (this.TENANT_RANGES[cacheKey]) return this.TENANT_RANGES[cacheKey];

        return new Promise((resolve, reject) => {
            const query = `SELECT range_min, range_max FROM platform_sequences WHERE tenant_id = ? AND generator_name = ?`;
            SQLConnect.pool.query(query, [tenantId, generatorName], async (err, results) => {
                if (err) return reject(err);
                if (results.length > 0) {
                    this.TENANT_RANGES[cacheKey] = { min: parseInt(results[0].range_min, 10), max: parseInt(results[0].range_max, 10) };
                    resolve(this.TENANT_RANGES[cacheKey]);
                } else {
                    // Force generate base bounds explicitly blocking exposure
                    try {
                        const baseVal = await this.getNextId(tenantId, generatorName);
                        // Back it down explicitly to not waste an ID physically 
                        const revertQuery = `UPDATE platform_sequences SET current_value = current_value - 1 WHERE tenant_id = ? AND generator_name = ?`;
                        SQLConnect.pool.query(revertQuery, [tenantId, generatorName], () => resolve(this.TENANT_RANGES[cacheKey]));
                    } catch (e) {
                        reject(e);
                    }
                }
            });
        });
    }

    static getTenantRangeSync(tenantId, generatorName) {
        return this.TENANT_RANGES[tenantId + '_' + generatorName] || { min: -1, max: -1 }; // Explicit fail safe
    }
}

module.exports = SequenceGenerator;
