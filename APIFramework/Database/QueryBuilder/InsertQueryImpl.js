'use strict';

class InsertQueryImpl {

    static DEFAULT             = 'DEFAULT';
    static IGNORE_ON_DUPLICATE = 'IGNORE_ON_DUPLICATE';

    constructor(tableName, condition = InsertQueryImpl.DEFAULT) {
        if (!tableName || typeof tableName !== 'string') {
            throw new Error('[InsertQueryImpl] tableName must be a non-empty string');
        }
        this._tableName  = tableName;
        this._condition  = condition;
        this._rows       = [];
        this._subQuery   = null;

        const SchemaRegistry = require('../ORM/SchemaRegistry');
        if (!SchemaRegistry.has(tableName)) {
            throw new Error(
                `[InsertQueryImpl] Table "${tableName}" is not registered in SchemaRegistry. ` +
                `Ensure DataDictionaryParser.parseDataDictionaries() ran before building queries.`
            );
        }
        this._schemaRegistry = SchemaRegistry;
    }

    addRow(plainObject) {
        if (this._subQuery) {
            throw new Error('[InsertQueryImpl] Cannot addRow() when a sub-query (INSERT...SELECT) is set');
        }
        if (!plainObject || typeof plainObject !== 'object') {
            throw new Error('[InsertQueryImpl] addRow() requires a plain object');
        }

        const tableDef = this._schemaRegistry.get(this._tableName);

        for (const col of Object.keys(plainObject)) {
            if (!tableDef[col]) {
                throw new Error(
                    `[InsertQueryImpl] Column "${col}" does not exist in table "${this._tableName}". ` +
                    `Known columns: ${Object.keys(tableDef).join(', ')}`
                );
            }
        }

        for (const [colName, colDef] of Object.entries(tableDef)) {
            if (colDef.required && !(colName in plainObject)) {
                throw new Error(
                    `[InsertQueryImpl] Required column "${colName}" is missing from the row for table "${this._tableName}".`
                );
            }
        }

        this._rows.push({ ...plainObject });
        return this;
    }

    addRows(plainObjects) {
        for (const row of plainObjects) this.addRow(row);
        return this;
    }

    setSubQuery(selectQuery) {
        if (this._rows.length > 0) {
            throw new Error('[InsertQueryImpl] Cannot setSubQuery() when rows have already been added via addRow()');
        }
        this._subQuery = selectQuery;
        return this;
    }

    setCondition(condition) {
        this._condition = condition;
        return this;
    }

    get tableName()      { return this._tableName; }
    get rows()           { return this._rows.slice(); }
    get numberOfRows()   { return this._rows.length; }
    get subQuery()       { return this._subQuery; }
    get condition()      { return this._condition; }
    get isIgnoreOnDupe() { return this._condition === InsertQueryImpl.IGNORE_ON_DUPLICATE; }

    get queryType() { return 'INSERT'; }
}

module.exports = InsertQueryImpl;
