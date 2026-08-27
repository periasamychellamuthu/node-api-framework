const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

class DataDictionaryParser {
    constructor() {
        // Flat map caching memory properties. E.g. DD_MAP["users.username"] = { "data-type": "CHAR", "max-size": 50 }
        this.DD_MAP = {};
        this.TABLE_DEFINITIONS = [];
    }

    async parseDataDictionaries(ddDirPath) {
        if (!fs.existsSync(ddDirPath)) {
            console.warn(`[DataDictionaryParser] Directory not found: ${ddDirPath}`);
            return;
        }

        const parser = new xml2js.Parser();

        // Collect all XML files that sit directly inside ddDirPath (flat layout).
        // e.g. src/schema/data-dictionary.xml
        // Subdirectory / dd-files.xml support is deferred to a later phase.
        const xmlFilesToParse = [];

        const entries = fs.readdirSync(ddDirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.xml')) {
                xmlFilesToParse.push(path.join(ddDirPath, entry.name));
            }
        }

        // Parse every collected XML file into DD_MAP and TABLE_DEFINITIONS
        for (const filePath of xmlFilesToParse) {
            try {
                const xmlData = fs.readFileSync(filePath, 'utf-8');
                const parsedData = await parser.parseStringPromise(xmlData);

                if (parsedData['data-dictionary'] && parsedData['data-dictionary'].table) {
                    const tables = Array.isArray(parsedData['data-dictionary'].table)
                        ? parsedData['data-dictionary'].table
                        : [parsedData['data-dictionary'].table];

                    tables.forEach(table => {
                        this.TABLE_DEFINITIONS.push(table);
                        const tableName = table.$.name;

                        if (table.columns && table.columns[0] && table.columns[0].column) {
                            const columns = Array.isArray(table.columns[0].column)
                                ? table.columns[0].column
                                : [table.columns[0].column];

                            columns.forEach(col => {
                                const colName = col.$.name;
                                this.DD_MAP[`${tableName}.${colName}`] = {
                                    'data-type': col['data-type'] && col['data-type'][0] ? col['data-type'][0] : null,
                                    'max-size':  col['max-size']  && col['max-size'][0]  ? parseInt(col['max-size'][0], 10) : null,
                                    'nullable':  col.nullable  && col.nullable[0]  === 'true',
                                    'unique':    col.unique    && col.unique[0]    === 'true'
                                };
                            });
                        }
                    });
                }
            } catch (e) {
                console.error(`[DataDictionaryParser] Failed parsing ${filePath}:`, e.message);
            }
        }

        console.log(`[DataDictionaryParser] Parsed ${xmlFilesToParse.length} file(s). Mapped ${Object.keys(this.DD_MAP).length} columns across ${this.TABLE_DEFINITIONS.length} tables.`);
    }

    /**
     * Retrieves specific dictionary properties mapping table + column structure.
     */
    getColumnProperty(tableName, columnName, propertyKey) {
        const mapping = this.DD_MAP[`${tableName}.${columnName}`];
        if (mapping && typeof mapping[propertyKey] !== 'undefined') {
            return mapping[propertyKey];
        }
        return null;
    }
}

// Single active cached map 
module.exports = new DataDictionaryParser();
