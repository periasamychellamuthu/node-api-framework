'use strict';

const Table = require('./Table');

class DeleteQueryImpl {

    constructor(table) {
        if (!table) throw new Error('[DeleteQueryImpl] table is required');
        if (typeof table === 'string') {
            this._table     = Table.getTable(table);
            this._tableName = table;
        } else {
            this._table     = table;
            this._tableName = table.name;
        }
        this._criteria    = null;
        this._joins       = [];
        this._sortColumns = [];
        this._limit       = null;
    }

    setCriteria(criteria) {
        this._criteria = criteria;
        return this;
    }

    addJoin(join) {
        this._joins.push(join);
        return this;
    }

    addSortColumn(sortColumn) {
        this._sortColumns.push(sortColumn);
        return this;
    }

    setLimit(limit) {
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error('[DeleteQueryImpl] limit must be a positive integer');
        }
        this._limit = limit;
        return this;
    }

    get table()       { return this._table; }
    get tableName()   { return this._tableName; }
    get criteria()    { return this._criteria; }
    get joins()       { return this._joins.slice(); }
    get sortColumns() { return this._sortColumns.slice(); }
    get limit()       { return this._limit; }

    get queryType() { return 'DELETE'; }
}

module.exports = DeleteQueryImpl;
