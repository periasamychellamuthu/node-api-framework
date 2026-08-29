'use strict';

const Table = require('./Table');

class Join {

    static INNER = 'INNER JOIN';
    static LEFT  = 'LEFT JOIN';
    static RIGHT = 'RIGHT JOIN';

    constructor(baseTable, referencedTable, baseColumns, referencedColumns, joinType, criteria) {
        this.baseTable         = typeof baseTable       === 'string' ? Table.getTable(baseTable)       : baseTable;
        this.referencedTable   = typeof referencedTable === 'string' ? Table.getTable(referencedTable) : referencedTable;
        this.baseColumns       = baseColumns       || [];
        this.referencedColumns = referencedColumns || [];
        this.joinType          = joinType          || Join.INNER;
        this.criteria          = criteria          || null;

        if (!this.criteria && this.baseColumns.length !== this.referencedColumns.length) {
            throw new Error(
                '[Join] baseColumns and referencedColumns must be the same length for equi-joins. ' +
                'Provide a Criteria for non-equi-joins.'
            );
        }

        Object.freeze(this);
    }
}

module.exports = Join;
