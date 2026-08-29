'use strict';

class GroupByClause {

    constructor(columns, having = null) {
        if (!Array.isArray(columns) || columns.length === 0) {
            throw new Error('[GroupByClause] at least one group-by column is required');
        }
        this.columns = columns;
        this.having  = having;
        Object.freeze(this);
    }
}

module.exports = GroupByClause;
