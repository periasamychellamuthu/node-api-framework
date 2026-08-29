'use strict';

const Table = require('./Table');

class Column {

    constructor(table, columnName, columnAlias = null, aggregateFunction = null, wrapped = null) {
        if (!columnName || typeof columnName !== 'string') {
            throw new Error('[Column] columnName must be a non-empty string');
        }
        this.table             = typeof table === 'string' ? Table.getTable(table) : table;
        this.columnName        = columnName;
        this.columnAlias       = columnAlias;
        this.aggregateFunction = aggregateFunction;
        this.wrapped           = wrapped;
        Object.freeze(this);
    }

    static DISTINCT = 'DISTINCT';
    static COUNT    = 'COUNT';
    static MIN      = 'MIN';
    static MAX      = 'MAX';
    static SUM      = 'SUM';
    static AVG      = 'AVG';

    static _cache = new Map();

    static getColumn(table, columnName) {
        const tableAlias = typeof table === 'string' ? table : table.alias;
        const key        = `${tableAlias}\0${columnName}`;
        if (!Column._cache.has(key)) {
            Column._cache.set(key, new Column(table, columnName));
        }
        return Column._cache.get(key);
    }

    static _clearCache() {
        Column._cache.clear();
    }

    count(alias)    { return this._wrap(Column.COUNT,    alias); }
    sum(alias)      { return this._wrap(Column.SUM,      alias); }
    avg(alias)      { return this._wrap(Column.AVG,      alias); }
    min(alias)      { return this._wrap(Column.MIN,      alias); }
    max(alias)      { return this._wrap(Column.MAX,      alias); }
    distinct(alias) { return this._wrap(Column.DISTINCT, alias); }

    as(alias) {
        return new Column(this.table, this.columnName, alias, this.aggregateFunction, this.wrapped);
    }

    _wrap(fn, alias) {
        const defaultAlias = alias || `${fn.toLowerCase()}_${this.columnName}`;
        return new Column(this.table, this.columnName, defaultAlias, fn, this);
    }

    toSQL() {
        const tableRef = this.table.alias || this.table.name;
        const colRef   = this.columnName === '*' ? '*' : `${tableRef}.${this.columnName}`;

        let expr;
        if (this.aggregateFunction === Column.DISTINCT) {
            expr = `DISTINCT ${colRef}`;
        } else if (this.aggregateFunction) {
            expr = `${this.aggregateFunction}(${colRef})`;
        } else {
            expr = colRef;
        }

        return this.columnAlias ? `${expr} AS ${this.columnAlias}` : expr;
    }

    toString() {
        return this.toSQL();
    }
}

module.exports = Column;
