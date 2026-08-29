'use strict';

class UpdateQueryImpl {

    constructor(tableName) {
        if (!tableName || typeof tableName !== 'string') {
            throw new Error('[UpdateQueryImpl] tableName must be a non-empty string');
        }
        this._tableName     = tableName;
        this._updateColumns = new Map();
        this._criteria      = null;
        this._joins         = [];
        this._sortColumns   = [];
    }

    setUpdateColumn(column, value) {
        this._updateColumns.set(column, value);
        return this;
    }

    setUpdateColumnByName(columnName, value) {
        const Column = require('./Column');
        this.setUpdateColumn(Column.getColumn(this._tableName, columnName), value);
        return this;
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

    get tableName()     { return this._tableName; }
    get updateColumns() { return new Map(this._updateColumns); }
    get criteria()      { return this._criteria; }
    get joins()         { return this._joins.slice(); }
    get sortColumns()   { return this._sortColumns.slice(); }

    get queryType() { return 'UPDATE'; }
}

module.exports = UpdateQueryImpl;
