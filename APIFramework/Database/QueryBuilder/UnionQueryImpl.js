'use strict';

class UnionQueryImpl {

    constructor(leftQuery, rightQuery, retainDuplicates = false) {
        if (!leftQuery)  throw new Error('[UnionQueryImpl] leftQuery is required');
        if (!rightQuery) throw new Error('[UnionQueryImpl] rightQuery is required');
        this._leftQuery        = leftQuery;
        this._rightQuery       = rightQuery;
        this._retainDuplicates = retainDuplicates;
        this._range            = null;
        this._sortColumns      = [];
    }

    union(other, retainDuplicates = false) {
        return new UnionQueryImpl(this, other, retainDuplicates);
    }

    setRange(range) {
        this._range = range;
        return this;
    }

    addSortColumn(sortColumn) {
        this._sortColumns.push(sortColumn);
        return this;
    }

    addSortColumns(sortColumns) {
        for (const s of sortColumns) this._sortColumns.push(s);
        return this;
    }

    get leftQuery()        { return this._leftQuery; }
    get rightQuery()       { return this._rightQuery; }
    get retainDuplicates() { return this._retainDuplicates; }
    get range()            { return this._range; }
    get sortColumns()      { return this._sortColumns.slice(); }

    get selectColumns() {
        return this._leftQuery.selectColumns;
    }

    get queryType() { return 'UNION'; }
}

module.exports = UnionQueryImpl;
