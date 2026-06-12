const DataDictionaryParser = require('../Configuration/DataDictionaryParser');
const SQLConnect = require('../../src/database/MYSQL/connect');

class SchemaBuilder {
    /**
     * Iterates all parsed Table Definitions mapping Data Dictionary bounds securely into executable MySQL DD L phrases.
     */
    static async syncSchema() {
        console.log(`[SchemaBuilder] Commencing Database Schema Sync over configured tables...`);
        const tables = DataDictionaryParser.TABLE_DEFINITIONS;

        if (!tables || tables.length === 0) {
            console.log(`[SchemaBuilder] No tables found in DataDictionaryParser cache.`);
            return;
        }

        // Wait for Connection explicitly bypassing builder mapping strictly extracting the absolute connection mapping cleanly
        await SQLConnect.init();

        // Ensure Platform Sequences architecture tracking bounds
        await new Promise((resolve, reject) => {
            const sqTables = `CREATE TABLE IF NOT EXISTS platform_sequences (
                tenant_id VARCHAR(100) NOT NULL,
                generator_name VARCHAR(150) NOT NULL,
                current_value BIGINT NOT NULL,
                range_min BIGINT NOT NULL,
                range_max BIGINT NOT NULL,
                PRIMARY KEY (tenant_id, generator_name)
            )`;
            SQLConnect.pool.query(sqTables, (err, res) => {
                if (err) return reject(err);
                resolve();
            });
        });

        for (const table of tables) {
            const tableName = table.$.name;
            const columnsDef = table.columns && table.columns[0] && table.columns[0].column ? table.columns[0].column : [];
            const pkDef = table['primary-key'] && table['primary-key'][0] && table['primary-key'][0]['primary-key-column'] ? table['primary-key'][0]['primary-key-column'][0] : null; // Usually an array, we assume simple PK

            let sqlBuilder = `CREATE TABLE IF NOT EXISTS ${tableName} (\n`;
            let definitions = [];

            columnsDef.forEach(col => {
                const name = col.$.name;
                const dataType = col['data-type'] && col['data-type'][0] ? col['data-type'][0] : 'VARCHAR';
                const maxSize = col['max-size'] && col['max-size'][0] ? col['max-size'][0] : null;
                const isNullable = col.nullable && col.nullable[0] === 'true';
                const isUnique = col.unique && col.unique[0] === 'true';

                let sqlCol = `  ${name} `;

                // Resolve structural type dynamically
                if (dataType === 'BIGINT') {
                    sqlCol += 'BIGINT';
                } else if (dataType === 'CHAR' || dataType === 'VARCHAR') {
                    sqlCol += `VARCHAR(${maxSize || 255})`;
                } else if (dataType === 'INTEGER' || dataType === 'INT') {
                    sqlCol += `INT`;
                } else if (dataType === 'BOOLEAN') {
                    sqlCol += `TINYINT(1)`;
                } else if (dataType === 'SBLOB' || dataType === 'TEXT') {
                    sqlCol += `TEXT`;
                } else {
                    sqlCol += dataType; // Fallback mapping dynamically 
                }

                if (!isNullable) {
                    sqlCol += ' NOT NULL';
                }

                if (isUnique) {
                    sqlCol += ' UNIQUE';
                }

                // Ensure IDs don't auto increment so generator can override
                // Auto Increment removed per manual Sequence Generator implementation logic

                definitions.push(sqlCol);
            });

            if (pkDef) {
                definitions.push(`  PRIMARY KEY (${pkDef})`);
            }

            sqlBuilder += definitions.join(',\n') + '\n);';

            try {
                await new Promise((resolve, reject) => {
                    SQLConnect.pool.query(sqlBuilder, (err, results) => {
                        if (err) return reject(err);
                        resolve(results);
                    });
                });
                console.log(`[SchemaBuilder] Validated / Synchronized Table: ${tableName}`);
            } catch (err) {
                console.error(`[SchemaBuilder] Error synchronizing table ${tableName}:`, err.message);
            }
        }

        console.log(`[SchemaBuilder] Schema Sync Completed.`);
    }
}

module.exports = SchemaBuilder;
