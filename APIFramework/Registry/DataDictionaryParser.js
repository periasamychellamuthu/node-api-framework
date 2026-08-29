'use strict';

const fs     = require('fs');
const path   = require('path');
const xml2js = require('xml2js');

class DataDictionaryParser {
    constructor() {
        this.DD_MAP             = {};   // "table.col" → { data-type, max-size, nullable, unique, auto-increment, default }
        this.FK_MAP             = {};   // tableName   → [{ name, fkColumn, refTable, refColumn }]
        this.INDEX_MAP          = {};   // tableName   → [{ name, unique, columns[] }]
        this.SEED_MAP           = {};   // tableName   → [{ col: value, ... }]
        this.TABLE_DEFINITIONS  = [];   // raw parsed table nodes (used by SchemaBuilder for DDL)
    }

    async parseDataDictionaries(...ddDirPaths) {
        const parser         = new xml2js.Parser();
        const xmlFilesToParse = [];

        for (const ddDirPath of ddDirPaths.flat()) {
            if (!fs.existsSync(ddDirPath)) {
                console.warn(`[DataDictionaryParser] Directory not found: ${ddDirPath}`);
                continue;
            }
            const entries = fs.readdirSync(ddDirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.xml')) {
                    xmlFilesToParse.push(path.join(ddDirPath, entry.name));
                }
            }
        }

        for (const filePath of xmlFilesToParse) {
            try {
                const xmlData    = fs.readFileSync(filePath, 'utf-8');
                const parsedData = await parser.parseStringPromise(xmlData);

                if (!parsedData['data-dictionary'] || !parsedData['data-dictionary'].table) continue;

                const tables = Array.isArray(parsedData['data-dictionary'].table)
                    ? parsedData['data-dictionary'].table
                    : [parsedData['data-dictionary'].table];

                tables.forEach(table => {
                    this.TABLE_DEFINITIONS.push(table);
                    const tableName = table.$.name;

                    // ── Columns → DD_MAP ─────────────────────────────────────
                    const colNodes = table.columns?.[0]?.column ?? [];
                    const cols = Array.isArray(colNodes) ? colNodes : [colNodes];
                    cols.forEach(col => {
                        const colName = col.$.name;
                        this.DD_MAP[`${tableName}.${colName}`] = {
                            'data-type':      col['data-type']?.[0]      ?? null,
                            'max-size':       col['max-size']?.[0]       ? parseInt(col['max-size'][0], 10) : null,
                            'nullable':       col.nullable?.[0]          === 'true',
                            'unique':         col.unique?.[0]            === 'true',
                            'auto-increment': col['auto-increment']?.[0] === 'true',
                            'default':        col.default?.[0]           ?? null,
                        };
                    });

                    // ── Foreign keys → FK_MAP ────────────────────────────────
                    const fkNodes = table['foreign-keys']?.[0]?.['foreign-key'];
                    if (fkNodes) {
                        const fks = Array.isArray(fkNodes) ? fkNodes : [fkNodes];
                        this.FK_MAP[tableName] = fks.map(fk => ({
                            name:      fk.$.name,
                            fkColumn:  fk['fk-column']?.[0]  ?? null,
                            refTable:  fk['ref-table']?.[0]  ?? null,
                            refColumn: fk['ref-column']?.[0] ?? null,
                        }));
                        console.log(`[DataDictionaryParser] Registered ${this.FK_MAP[tableName].length} FK(s) for table: ${tableName}`);
                    }

                    // ── Indexes → INDEX_MAP ──────────────────────────────────
                    const idxNodes = table.indexes?.[0]?.index;
                    if (idxNodes) {
                        const idxs = Array.isArray(idxNodes) ? idxNodes : [idxNodes];
                        this.INDEX_MAP[tableName] = idxs.map(idx => ({
                            name:    idx.$.name,
                            unique:  idx.$.unique === 'true',
                            columns: (Array.isArray(idx['index-column']) ? idx['index-column'] : [idx['index-column']]).filter(Boolean),
                        }));
                    }

                    // ── Seed rows → SEED_MAP ─────────────────────────────────
                    const seedNodes = table.seed?.[0]?.row;
                    if (seedNodes) {
                        const rows = Array.isArray(seedNodes) ? seedNodes : [seedNodes];
                        this.SEED_MAP[tableName] = rows.map(row => {
                            const obj = {};
                            const vals = Array.isArray(row.value) ? row.value : [row.value];
                            vals.forEach(v => { obj[v.$.column] = v._; });
                            return obj;
                        });
                    }
                });

            } catch (e) {
                console.error(`[DataDictionaryParser] Failed parsing ${filePath}:`, e.message);
            }
        }

        const fkTotal = Object.values(this.FK_MAP).reduce((s, a) => s + a.length, 0);
        console.log(
            `[DataDictionaryParser] Parsed ${xmlFilesToParse.length} file(s). ` +
            `Mapped ${Object.keys(this.DD_MAP).length} columns across ${this.TABLE_DEFINITIONS.length} tables. ` +
            `Registered ${fkTotal} FK(s) across ${Object.keys(this.FK_MAP).length} table(s).`
        );
    }

    getColumnProperty(tableName, columnName, propertyKey) {
        const mapping = this.DD_MAP[`${tableName}.${columnName}`];
        return (mapping && mapping[propertyKey] !== undefined) ? mapping[propertyKey] : null;
    }

    getTableForeignKeys(tableName) {
        return this.FK_MAP[tableName] || [];
    }

    getTableIndexes(tableName) {
        return this.INDEX_MAP[tableName] || [];
    }

    getTableSeedRows(tableName) {
        return this.SEED_MAP[tableName] || [];
    }
}

module.exports = new DataDictionaryParser();
