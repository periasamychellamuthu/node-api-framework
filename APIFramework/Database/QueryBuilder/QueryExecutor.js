'use strict';

const knex            = require('../KnexClient');
const Criteria        = require('./Criteria');
const SelectQueryImpl = require('./SelectQueryImpl');
const UpdateQueryImpl = require('./UpdateQueryImpl');
const DeleteQueryImpl = require('./DeleteQueryImpl');
const InsertQueryImpl = require('./InsertQueryImpl');
const UnionQueryImpl  = require('./UnionQueryImpl');

function columnRef(col) {
    if (col.columnName === '*') return '*';
    const tableRef = col.table ? (col.table.alias || col.table.name) : null;
    const colRef   = tableRef ? `${tableRef}.${col.columnName}` : col.columnName;

    if (!col.aggregateFunction) {
        return col.columnAlias ? knex.raw(`?? AS ??`, [colRef, col.columnAlias]) : colRef;
    }

    const fn    = col.aggregateFunction;
    const expr  = fn === 'DISTINCT' ? `DISTINCT ${colRef}` : `${fn}(${colRef})`;
    const alias = col.columnAlias || `${fn.toLowerCase()}_${col.columnName}`;
    return knex.raw(`${expr} AS ??`, [alias]);
}

function applyCriteriaTree(qb, criteria) {
    if (!criteria) return qb;

    if (criteria.isLeaf()) {
        _applyLeaf(qb, criteria.column, criteria.comparator, criteria.value);
    } else if (criteria.isComposite()) {
        if (criteria.operator === 'AND') {
            qb.where(inner => {
                applyCriteriaTree(inner, criteria.left);
                applyCriteriaTree(inner, criteria.right);
            });
        } else {
            applyCriteriaTree(qb, criteria.left);
            qb.orWhere(inner => applyCriteriaTree(inner, criteria.right));
        }
    } else if (criteria.isNegated()) {
        qb.whereNot(inner => applyCriteriaTree(inner, criteria.inner));
    }

    return qb;
}

function _applyLeaf(qb, col, comparator, value) {
    const ref = columnRef(col);

    switch (comparator) {
        case Criteria.EQUAL:         qb.where(ref, value);                    break;
        case Criteria.NOT_EQUAL:     qb.whereNot(ref, value);                break;
        case Criteria.LESS_THAN:     qb.where(ref, '<',  value);             break;
        case Criteria.LESS_EQUAL:    qb.where(ref, '<=', value);             break;
        case Criteria.GREATER_THAN:  qb.where(ref, '>',  value);             break;
        case Criteria.GREATER_EQUAL: qb.where(ref, '>=', value);             break;
        case Criteria.IN:            qb.whereIn(ref, value);                  break;
        case Criteria.NOT_IN:        qb.whereNotIn(ref, value);               break;
        case Criteria.LIKE:          qb.where(ref, 'LIKE', `%${value}%`);    break;
        case Criteria.NOT_LIKE:      qb.where(ref, 'NOT LIKE', `%${value}%`); break;
        case Criteria.STARTS_WITH:   qb.where(ref, 'LIKE', `${value}%`);     break;
        case Criteria.BETWEEN:       qb.whereBetween(ref, value);             break;
        case Criteria.NOT_BETWEEN:   qb.whereNotBetween(ref, value);          break;
        case Criteria.IS_NULL:       qb.whereNull(ref);                        break;
        case Criteria.IS_NOT_NULL:   qb.whereNotNull(ref);                     break;
        default:
            throw new Error(`[QueryExecutor] Unknown comparator "${comparator}"`);
    }
}

function applyJoins(qb, joins) {
    for (const join of joins) {
        const method = join.joinType === 'LEFT JOIN'  ? 'leftJoin'
                     : join.joinType === 'RIGHT JOIN' ? 'rightJoin'
                     : 'join';

        const refTable = join.referencedTable.alias !== join.referencedTable.name
            ? `${join.referencedTable.name} AS ${join.referencedTable.alias}`
            : join.referencedTable.name;

        if (join.criteria) {
            qb[method](refTable, function() { applyCriteriaTree(this, join.criteria); });
        } else {
            const baseAlias = join.baseTable.alias || join.baseTable.name;
            const refAlias  = join.referencedTable.alias || join.referencedTable.name;

            if (join.baseColumns.length === 1) {
                qb[method](refTable, `${baseAlias}.${join.baseColumns[0]}`, `${refAlias}.${join.referencedColumns[0]}`);
            } else {
                qb[method](refTable, function() {
                    join.baseColumns.forEach((bc, i) => {
                        this.on(`${baseAlias}.${bc}`, `${refAlias}.${join.referencedColumns[i]}`);
                    });
                });
            }
        }
    }
}

function applySortColumns(qb, sortColumns) {
    for (const sc of sortColumns) {
        qb.orderByRaw(sc.toSQL());
    }
}

function applyRange(qb, range) {
    if (!range) return;
    if (!range.isUnbounded) qb.limit(range.numberOfObjects);
    if (range.startIndex > 0) qb.offset(range.startIndex);
}

async function buildSelectSQL(query, qbRoot) {
    const tableName = query.baseTable.alias !== query.baseTable.name
        ? `${query.baseTable.name} AS ${query.baseTable.alias}`
        : query.baseTable.name;

    const qb = qbRoot(tableName);

    if (query.selectColumns.length > 0) {
        qb.select(query.selectColumns.map(columnRef));
    } else {
        qb.select('*');
    }

    if (query.distinct) qb.distinct();

    applyJoins(qb, query.joins);
    if (query.criteria) applyCriteriaTree(qb, query.criteria);

    if (query.groupBy) {
        qb.groupByRaw(query.groupBy.columns.map(columnRef).join(', '));
        if (query.groupBy.having) {
            qb.havingWrapped(h => applyCriteriaTree(h, query.groupBy.having));
        }
    }

    applySortColumns(qb, query.sortColumns);
    applyRange(qb, query.range);

    if (query.lockForUpdate) qb.forUpdate();

    return qb;
}

async function buildUpdateSQL(query, qbRoot) {
    const qb = qbRoot(query.tableName);

    const setMap = {};
    for (const [col, val] of query.updateColumns) {
        setMap[col.columnName] = val;
    }

    qb.update(setMap);
    applyJoins(qb, query.joins);
    if (query.criteria) applyCriteriaTree(qb, query.criteria);
    applySortColumns(qb, query.sortColumns);

    return qb;
}

async function buildDeleteSQL(query, qbRoot) {
    const qb = qbRoot(query.tableName).delete();
    applyJoins(qb, query.joins);
    if (query.criteria) applyCriteriaTree(qb, query.criteria);
    applySortColumns(qb, query.sortColumns);
    if (query.limit !== null) qb.limit(query.limit);
    return qb;
}

async function buildInsertSQL(query, qbRoot) {
    const qb = qbRoot(query.tableName);

    if (query.subQuery) {
        const subQb = await buildSelectSQL(query.subQuery, qbRoot);
        return qb.insert(subQb);
    }

    if (query.rows.length === 0) {
        throw new Error('[QueryExecutor] InsertQueryImpl has no rows to insert');
    }

    if (query.isIgnoreOnDupe) {
        return qb.insert(query.rows).onConflict().ignore();
    }

    return qb.insert(query.rows);
}

async function buildUnionSQL(query, qbRoot) {
    const leftQb  = await _buildSide(query.leftQuery,  qbRoot);
    const rightQb = await _buildSide(query.rightQuery, qbRoot);

    const unionKeyword = query.retainDuplicates ? 'UNION ALL' : 'UNION';

    const leftSQL  = leftQb.toSQL();
    const rightSQL = rightQb.toSQL();

    let rawSQL = `(${leftSQL.sql}) ${unionKeyword} (${rightSQL.sql})`;
    const bindings = [...leftSQL.bindings, ...rightSQL.bindings];

    if (query.sortColumns.length > 0) {
        rawSQL += ` ORDER BY ${query.sortColumns.map(sc => sc.toSQL()).join(', ')}`;
    }

    if (query.range && !query.range.isUnbounded) {
        rawSQL += ` LIMIT ?`;
        bindings.push(query.range.numberOfObjects);
    }
    if (query.range && query.range.startIndex > 0) {
        rawSQL += ` OFFSET ?`;
        bindings.push(query.range.startIndex);
    }

    return qbRoot.raw(rawSQL, bindings);
}

async function _buildSide(sideQuery, qbRoot) {
    if (sideQuery.queryType === 'SELECT') return buildSelectSQL(sideQuery, qbRoot);
    if (sideQuery.queryType === 'UNION')  return buildUnionSQL(sideQuery, qbRoot);
    throw new Error(`[QueryExecutor] UNION side must be SELECT or UNION, got: ${sideQuery.queryType}`);
}

const QueryExecutor = {

    async execute(queryImpl, trx) {
        const qbRoot = trx || knex;

        switch (queryImpl.queryType) {
            case 'SELECT': return buildSelectSQL(queryImpl, qbRoot);
            case 'UPDATE': return buildUpdateSQL(queryImpl, qbRoot);
            case 'DELETE': return buildDeleteSQL(queryImpl, qbRoot);
            case 'INSERT': return buildInsertSQL(queryImpl, qbRoot);
            case 'UNION':  return buildUnionSQL(queryImpl, qbRoot);
            default:
                throw new Error(`[QueryExecutor] Unknown query type: ${queryImpl.queryType}`);
        }
    },

    applyCriteriaTree,
    applyJoins,
    applySortColumns,
    applyRange,
    columnRef,
};

module.exports = QueryExecutor;
