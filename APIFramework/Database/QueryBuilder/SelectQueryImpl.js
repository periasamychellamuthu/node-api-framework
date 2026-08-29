'use strict';

const Table = require('./Table');

class SelectQueryImpl {

    constructor(baseTable) {
        if (!baseTable) throw new Error('[SelectQueryImpl] baseTable is required');
        this._baseTable     = typeof baseTable === 'string' ? Table.getTable(baseTable) : baseTable;
        this._selectColumns = [];
        this._criteria      = null;
        this._joins         = [];
        this._sortColumns   = [];
        this._range         = null;
        this._groupBy       = null;
        this._distinct      = false;
        this._lockForUpdate = false;
        this._immutable     = false;
    }

    _checkMutable() {
        if (this._immutable) {
            throw new Error('[SelectQueryImpl] This query has been made immutable. Clone it before mutating.');
        }
    }

    makeImmutable() {
        this._immutable = true;
        return this;
    }

    get isImmutable() { return this._immutable; }

    addSelectColumn(column) {
        this._checkMutable();
        this._selectColumns.push(column);
        return this;
    }

    addSelectColumns(columns) {
        this._checkMutable();
        for (const col of columns) this._selectColumns.push(col);
        return this;
    }

    setCriteria(criteria) {
        this._checkMutable();
        this._criteria = criteria;
        return this;
    }

    addJoin(join) {
        this._checkMutable();
        this._joins.push(join);
        return this;
    }

    addSortColumn(sortColumn) {
        this._checkMutable();
        this._sortColumns.push(sortColumn);
        return this;
    }

    addSortColumns(sortColumns) {
        this._checkMutable();
        for (const s of sortColumns) this._sortColumns.push(s);
        return this;
    }

    setRange(range) {
        this._checkMutable();
        this._range = range;
        return this;
    }

    setGroupByClause(clause) {
        this._checkMutable();
        this._groupBy = clause;
        return this;
    }

    setDistinct(distinct) {
        this._checkMutable();
        this._distinct = !!distinct;
        return this;
    }

    setLockForUpdate(lock) {
        this._checkMutable();
        this._lockForUpdate = !!lock;
        return this;
    }

    get baseTable()     { return this._baseTable; }
    get selectColumns() { return this._selectColumns.slice(); }
    get criteria()      { return this._criteria; }
    get joins()         { return this._joins.slice(); }
    get sortColumns()   { return this._sortColumns.slice(); }
    get range()         { return this._range; }
    get groupBy()       { return this._groupBy; }
    get distinct()      { return this._distinct; }
    get lockForUpdate() { return this._lockForUpdate; }

    deepClone() {
        const clone = new SelectQueryImpl(this._baseTable);
        clone._selectColumns = this._selectColumns.slice();
        clone._criteria      = this._criteria;
        clone._joins         = this._joins.slice();
        clone._sortColumns   = this._sortColumns.slice();
        clone._range         = this._range;
        clone._groupBy       = this._groupBy;
        clone._distinct      = this._distinct;
        clone._lockForUpdate = this._lockForUpdate;
        return clone;
    }

    get queryType() { return 'SELECT'; }
}

module.exports = SelectQueryImpl;
