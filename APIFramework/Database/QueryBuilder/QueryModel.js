class Table {
    constructor(tableName, alias = null) {
        this.tableName = tableName;
        this.alias = alias || tableName;
    }

    static getTable(tableName, alias) {
        return new Table(tableName, alias);
    }
}

class Column {
    constructor(table, columnName) {
        this.table = typeof table === 'string' ? new Table(table) : table;
        this.columnName = columnName;
    }

    static getColumn(tableName, columnName) {
        return new Column(tableName, columnName);
    }
}

class AggregateFunction {
    constructor(type, column, alias = null) {
        this.type = type; // e.g. COUNT, SUM, AVG
        this.column = column; // Column instance
        this.alias = alias || `${type}_${column.columnName}`;
    }

    static count(column, alias) { return new AggregateFunction('COUNT', column, alias); }
    static sum(column, alias) { return new AggregateFunction('SUM', column, alias); }
    static avg(column, alias) { return new AggregateFunction('AVG', column, alias); }
}

class SubQuery {
    constructor(selectQuery, alias) {
        // Accepts a full SelectQuery instance to nest
        this.selectQuery = selectQuery;
        this.alias = alias;
    }
}

class Join {
    constructor(baseTable, joinTable, baseColumns, joinColumns, joinType) {
        this.baseTable = typeof baseTable === 'string' ? new Table(baseTable) : baseTable;
        this.joinTable = typeof joinTable === 'string' ? new Table(joinTable) : joinTable;
        this.baseColumns = baseColumns; // Array of column names
        this.joinColumns = joinColumns; // Array of column names
        this.joinType = joinType || Join.INNER_JOIN;
    }

    static get INNER_JOIN() { return 'INNER JOIN'; }
    static get LEFT_JOIN() { return 'LEFT JOIN'; }
    static get RIGHT_JOIN() { return 'RIGHT JOIN'; }
}

const QueryConstants = {
    EQUAL: '=',
    NOT_EQUAL: '!=',
    GREATER_THAN: '>',
    GREATER_EQUAL: '>=',
    LESS_THAN: '<',
    LESS_EQUAL: '<=',
    LIKE: 'LIKE',
    NOT_LIKE: 'NOT LIKE',
    IN: 'IN',
    NOT_IN: 'NOT IN'
};

class Criteria {
    constructor(column, value, condition) {
        this.column = column;
        this.value = value;
        this.condition = condition;
        this.logicalOperator = 'AND';
        this.groupedCriteria = [];
    }

    and(criteria) {
        const newCriteria = new Criteria();
        newCriteria.groupedCriteria = [this, criteria];
        newCriteria.logicalOperator = 'AND';
        return newCriteria;
    }

    or(criteria) {
        const newCriteria = new Criteria();
        newCriteria.groupedCriteria = [this, criteria];
        newCriteria.logicalOperator = 'OR';
        return newCriteria;
    }
}

class SelectQuery {
    constructor(baseTable) {
        this.baseTable = typeof baseTable === 'string' ? new Table(baseTable) : baseTable;
        this.selectColumns = [];
        this.joins = [];
        this.criteria = null;
        this.sortColumns = [];
        this.range = null;
    }

    addSelectColumn(column) {
        this.selectColumns.push(column);
    }

    addJoin(join) {
        this.joins.push(join);
    }

    setCriteria(criteria) {
        this.criteria = criteria;
    }

    addSortColumn(column, isAscending = true) {
        this.sortColumns.push({ column, sortOrder: isAscending ? 'ASC' : 'DESC' });
    }

    setRange(offset, limit) {
        this.range = { offset, limit };
    }
}

/*
 * Sample Query Implementations:
 * 
 * --- POST (Insert) ---
 *   var qb = ...
 *   var results = await this.queryBuilder.queryInsert(qb, {
 *       table: "users", 
 *       data: { username: "admin", email: "admin@test.com" }
 *   });
 * 
 * --- PUT (Update) ---
 *   var qb = ...
 *   this.queryBuilder.queryUpdate(qb, {
 *       table: "users",
 *       data: { username: "admin2" },
 *       criteria: { id: "1" }
 *   });
 * 
 * --- DELETE ---
 *   var qb = ...
 *   var results = await this.queryBuilder.queryDelete(qb, {
 *       table: "users"
 *   }); // Uses implicit Criteria populated in APIRequest Context
 */

// Contains all query DSL data model classes: Table, Column, Criteria, SelectQuery, Join, etc.
module.exports = {
    Table,
    Column,
    AggregateFunction,
    SubQuery,
    Join,
    QueryConstants,
    Criteria,
    SelectQuery
};
