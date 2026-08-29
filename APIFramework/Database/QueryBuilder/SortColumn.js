'use strict';

class SortColumn {

    constructor(column, ascending = true, nullsFirst = null) {
        if (!column) throw new Error('[SortColumn] column is required');
        this.column     = column;
        this.ascending  = ascending;
        this.nullsFirst = nullsFirst;
        Object.freeze(this);
    }

    static asc(column, nullsFirst = null) {
        return new SortColumn(column, true, nullsFirst);
    }

    static desc(column, nullsFirst = null) {
        return new SortColumn(column, false, nullsFirst);
    }

    toSQL() {
        const colExpr   = this.column.toSQL();
        const dir       = this.ascending ? 'ASC' : 'DESC';
        const nullsPart = this.nullsFirst === true  ? ' NULLS FIRST'
                        : this.nullsFirst === false ? ' NULLS LAST'
                        : '';
        return `${colExpr} ${dir}${nullsPart}`;
    }
}

module.exports = SortColumn;
