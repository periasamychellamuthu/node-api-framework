'use strict';

const DataDictionaryParser = require('../Registry/DataDictionaryParser');
const SQLConnect           = require('./DBConnectionPool');
const SequenceGenerator    = require('./SequenceGenerator');

/**
 * SchemaBuilder — Database schema lifecycle manager.
 *
 * All tables — framework IAM tables and product tables — are declared in
 * data-dictionary XML files and driven through a single syncSchema() pass.
 * No DDL is hardcoded here.
 *
 * Boot order (called from main.js):
 *   1. syncSchema()          — CREATE TABLE IF NOT EXISTS for every table in DD XML
 *   2. seedFrameworkData()   — INSERT IGNORE seed rows declared via <seed> in DD XML
 *   3. warmSequenceGenerator() — load org ID ranges into memory
 */
class SchemaBuilder {

    static async syncSchema() {
        console.log('[SchemaBuilder] Syncing schema from data dictionary...');
        const tables = DataDictionaryParser.TABLE_DEFINITIONS;

        if (!tables || tables.length === 0) {
            console.warn('[SchemaBuilder] No tables in DataDictionaryParser — ensure parseDataDictionaries() ran first.');
            return;
        }

        // ── Pass 1: CREATE TABLE (columns + PK only, NO foreign keys) ─────────
        //
        // FK constraints are intentionally excluded here. MySQL validates FK
        // references at CREATE TABLE time — if the referenced table has not been
        // created yet (because DD XML files are parsed in filesystem order, not
        // dependency order), the statement fails with
        //   "Failed to open the referenced table '<name>'".
        //
        // Solution: create all tables first, then add FKs in a separate pass
        // (ALTER TABLE ... ADD CONSTRAINT) once every table exists.
        for (const table of tables) {
            const tableName = table.$.name;

            const colNodes = table.columns?.[0]?.column ?? [];
            const cols     = Array.isArray(colNodes) ? colNodes : [colNodes];
            const pkNode   = table['primary-key']?.[0]?.['primary-key-column']?.[0] ?? null;

            const definitions = [];

            cols.forEach(col => {
                const name          = col.$.name;
                const rawType       = col['data-type']?.[0] ?? 'VARCHAR';
                const maxSize       = col['max-size']?.[0]  ?? null;
                const nullable      = col.nullable?.[0]          === 'true';
                const unique        = col.unique?.[0]            === 'true';
                const autoIncrement = col['auto-increment']?.[0] === 'true';
                const defaultVal    = col.default?.[0]           ?? null;

                let sqlType;
                switch (rawType.toUpperCase()) {
                    case 'BIGINT':                           sqlType = 'BIGINT';                        break;
                    case 'VARCHAR': case 'CHAR':             sqlType = `VARCHAR(${maxSize || 255})`;    break;
                    case 'INT': case 'INTEGER':              sqlType = 'INT';                           break;
                    case 'BOOLEAN':                          sqlType = 'TINYINT(1)';                    break;
                    case 'TEXT': case 'SBLOB':               sqlType = 'TEXT';                          break;
                    case 'DECIMAL':                          sqlType = `DECIMAL(${maxSize || '20,4'})`; break;
                    case 'DATETIME': case 'TIMESTAMP':       sqlType = 'DATETIME';                      break;
                    case 'DATE':                             sqlType = 'DATE';                          break;
                    case 'JSON':                             sqlType = 'JSON';                          break;
                    default:                                 sqlType = rawType;
                }

                let colDef = `  ${name} ${sqlType}`;
                if (autoIncrement) colDef += ' AUTO_INCREMENT';
                if (!nullable)     colDef += ' NOT NULL';
                if (unique)        colDef += ' UNIQUE';
                if (defaultVal !== null) {
                    const needsQuotes = ['VARCHAR', 'CHAR', 'TEXT'].includes(rawType.toUpperCase());
                    colDef += needsQuotes ? ` DEFAULT '${defaultVal}'` : ` DEFAULT ${defaultVal}`;
                }
                definitions.push(colDef);
            });

            if (pkNode) definitions.push(`  PRIMARY KEY (${pkNode})`);

            const ddl = `CREATE TABLE IF NOT EXISTS ${tableName} (\n${definitions.join(',\n')}\n)`;
            try {
                await SQLConnect.query(ddl);
                console.log(`[SchemaBuilder] Ensured table: ${tableName}`);
            } catch (err) {
                console.error(`[SchemaBuilder] Error on table ${tableName}: ${err.message}`);
                console.error(`[SchemaBuilder] DDL:\n${ddl}`);
            }

            // ── Secondary indexes (safe here — no cross-table deps) ───────────
            const indexes = DataDictionaryParser.getTableIndexes(tableName);
            for (const idx of indexes) {
                const uniqueKw = idx.unique ? 'UNIQUE ' : '';
                const idxDdl   = `CREATE ${uniqueKw}INDEX ${idx.name} ON ${tableName} (${idx.columns.join(', ')})`;
                try {
                    await SQLConnect.query(idxDdl);
                } catch (err) {
                    // ER_DUP_KEYNAME (1061) — index already exists, safe to ignore
                    if (err.code !== 'ER_DUP_KEYNAME' && !err.message.includes('Duplicate key name')) {
                        console.error(`[SchemaBuilder] Index error on ${tableName}.${idx.name}: ${err.message}`);
                    }
                }
            }
        }

        // ── Pass 2: ADD FOREIGN KEY constraints (all tables now exist) ────────
        for (const table of tables) {
            const tableName  = table.$.name;
            const foreignKeys = DataDictionaryParser.getTableForeignKeys(tableName);
            for (const fk of foreignKeys) {
                if (!fk.name || !fk.fkColumn || !fk.refTable || !fk.refColumn) continue;
                const alterDdl =
                    `ALTER TABLE ${tableName} ` +
                    `ADD CONSTRAINT ${fk.name} ` +
                    `FOREIGN KEY (${fk.fkColumn}) REFERENCES ${fk.refTable}(${fk.refColumn})`;
                try {
                    await SQLConnect.query(alterDdl);
                    console.log(`[SchemaBuilder] Added FK: ${fk.name} on ${tableName}`);
                } catch (err) {
                    // ER_DUP_KEYNAME (1061) / ER_FK_DUP_NAME (1826) — FK already exists, safe to ignore
                    if (err.errno === 1061 || err.errno === 1826 ||
                        err.message.includes('Duplicate key name') ||
                        err.message.includes('already exists')) {
                        // silently skip — FK was added in a previous boot
                    } else {
                        console.error(`[SchemaBuilder] FK error ${fk.name} on ${tableName}: ${err.message}`);
                    }
                }
            }
        }

        console.log('[SchemaBuilder] Schema sync complete.');
    }

    static async seedFrameworkData() {
        const tables = DataDictionaryParser.TABLE_DEFINITIONS;
        for (const table of tables) {
            const tableName = table.$.name;
            const seedRows  = DataDictionaryParser.getTableSeedRows(tableName);
            if (seedRows.length === 0) continue;

            // Derive PK column(s) from the table definition
            const pkNode = table['primary-key']?.[0]?.['primary-key-column']?.[0] ?? null;
            const pkCols = pkNode ? pkNode.split(',').map(s => s.trim()) : [];

            for (const row of seedRows) {
                const cols = Object.keys(row);
                const vals = Object.values(row);
                const placeholders = cols.map(() => '?').join(', ');
                const sql  = `INSERT IGNORE INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`;
                try {
                    await SQLConnect.query(sql, vals);
                } catch (err) {
                    console.error(`[SchemaBuilder] Seed error on ${tableName}: ${err.message}`);
                }
            }
            console.log(`[SchemaBuilder] Seeded ${seedRows.length} row(s) into ${tableName}.`);
        }
    }

    static async warmSequenceGenerator() {
        await SequenceGenerator.loadAllRanges();
    }
}

module.exports = SchemaBuilder;
