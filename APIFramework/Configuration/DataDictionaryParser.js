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
        const directories = fs.readdirSync(ddDirPath, { withFileTypes: true });

        for (const dir of directories) {
            if (dir.isDirectory()) {
                const modulePath = path.join(ddDirPath, dir.name);
                const ddFilesPath = path.join(modulePath, 'dd-files.xml');
                
                let filesToParse = ['data-dictionary.xml'];

                // Explicit Fragment mappings parsing
                if (fs.existsSync(ddFilesPath)) {
                    try {
                        const indexXml = fs.readFileSync(ddFilesPath, 'utf-8');
                        const indexParsed = await parser.parseStringPromise(indexXml);
                        if (indexParsed && indexParsed.ConfFileList && indexParsed.ConfFileList.ConfFile) {
                            const confFiles = Array.isArray(indexParsed.ConfFileList.ConfFile) ? indexParsed.ConfFileList.ConfFile : [indexParsed.ConfFileList.ConfFile];
                            filesToParse = confFiles.map(cf => cf.$.url);
                        }
                    } catch (e) {
                        console.error(`[DataDictionaryParser] Failed parsing dd-files.xml in ${modulePath}:`, e.message);
                    }
                }

                // Process Dictionary XMLs
                for (const fileName of filesToParse) {
                    const filePath = path.join(modulePath, fileName);
                    if (fs.existsSync(filePath)) {
                        try {
                            const xmlData = fs.readFileSync(filePath, 'utf-8');
                            const parsedData = await parser.parseStringPromise(xmlData);
                            
                            if (parsedData['data-dictionary'] && parsedData['data-dictionary'].table) {
                                const tables = Array.isArray(parsedData['data-dictionary'].table) ? parsedData['data-dictionary'].table : [parsedData['data-dictionary'].table];
                                
                                tables.forEach(table => {
                                    this.TABLE_DEFINITIONS.push(table);
                                    const tableName = table.$.name;
                                    if (table.columns && table.columns[0] && table.columns[0].column) {
                                        const columns = Array.isArray(table.columns[0].column) ? table.columns[0].column : [table.columns[0].column];
                                        
                                        columns.forEach(col => {
                                            const colName = col.$.name;
                                            const mapKey = `${tableName}.${colName}`;
                                            
                                            this.DD_MAP[mapKey] = {
                                                'data-type': col['data-type'] && col['data-type'][0] ? col['data-type'][0] : null,
                                                'max-size': col['max-size'] && col['max-size'][0] ? parseInt(col['max-size'][0], 10) : null,
                                                'nullable': col.nullable && col.nullable[0] === 'true',
                                                'unique': col.unique && col.unique[0] === 'true'
                                            };
                                        });
                                    }
                                });
                            }
                        } catch (e) {
                            console.error(`[DataDictionaryParser] Failed parsing Schema XML ${filePath}:`, e.message);
                        }
                    }
                }
            }
        }
        console.log(`[DataDictionaryParser] Successfully mapped ${Object.keys(this.DD_MAP).length} column structures to Memory Cache.`);
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
