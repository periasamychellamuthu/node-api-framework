'use strict';

const knex              = require('../KnexClient');
const SchemaRegistry    = require('./SchemaRegistry');
const Row               = require('./Row');
const DataObject        = require('./DataObject');
const { applyCriteria, CriteriaBuilder } = require('./Criteria');
const QueryExecutor     = require('../QueryBuilder/QueryExecutor');
const SelectQueryImpl   = require('../QueryBuilder/SelectQueryImpl');
const UpdateQueryImpl   = require('../QueryBuilder/UpdateQueryImpl');
const DeleteQueryImpl   = require('../QueryBuilder/DeleteQueryImpl');
const InsertQueryImpl   = require('../QueryBuilder/InsertQueryImpl');
const UnionQueryImpl    = require('../QueryBuilder/UnionQueryImpl');
const Criteria          = require('../QueryBuilder/Criteria');
const Column            = require('../QueryBuilder/Column');
const RequestContext     = require('../../Context/RequestContext');

class DataAccess {

    constructDataObject() {
        return new DataObject();
    }

    newRow(tableName) {
        return new Row(tableName);
    }

    // ── DataObject — stage then flush ─────────────────────────────────────────
    //
    // All row mutations are staged directly on the DataObject, then flushed
    // via a single dataAccess call. This is the two-step model:
    //
    //   Step 1 — Stage on DataObject:
    //     dObj.addRow(row)              → INSERT (RowRef handles parent-child FK wiring)
    //     dObj.updateRow(row)           → UPDATE (only dirty columns written)
    //     dObj.deleteRow(row)           → DELETE one specific fetched row
    //     dObj.deleteRows(table, crit)  → DELETE all rows matching a CriteriaBuilder filter
    //
    //   Step 2 — Flush:
    //     await dataAccess.add(dObj, trx)              → flushes ADD rows only
    //     await dataAccess.update(dObj, trx)           → flushes UPDATE rows only
    //     await dataAccess.delete(dObj, trx)           → flushes DELETE rows only
    //     await dataAccess.persistDataObject(dObj, trx)→ flushes ADD + UPDATE + DELETE atomically
    //
    // Always pass the active Knex trx from TransactionManager.beginTxn() so all
    // writes participate in the same transaction and roll back together on error.

    /**
     * Flushes ALL pending operations (ADD + UPDATE + DELETE) from a DataObject
     * in a single atomic transaction.
     *
     * Execution order:
     *   1. INSERT  rows — FK-dependency order via topo-sort; RowRef placeholders resolved
     *   2. UPDATE  rows — only dirty columns written per row
     *   3. DELETE  rows — reverse FK order; both row-by-row and criteria-scoped deletes
     *
     * Prefer passing an active trx from TransactionManager.beginTxn() so this flush
     * participates in the caller's transaction. When trx is omitted a new internal
     * Knex transaction is opened for this flush only.
     *
     * @param {DataObject} dObj
     * @param {import('knex').Knex.Transaction} [trx]
     */
    async persistDataObject(dObj, trx) {
        const execute = async (qb) => {
            // ── 1. INSERT ────────────────────────────────────────────────────────
            const insertTables = this._topoSort([...dObj.tableNames()], 'INSERT');
            for (const table of insertTables) {
                const pkCol = SchemaRegistry.getPrimaryKey(table);
                for (const row of dObj.getAddedRows(table)) {
                    const resolved   = row.toResolvedObject();
                    const [insertId] = await qb(table).insert(resolved);
                    if (pkCol && insertId && !row._current[pkCol]) {
                        row._current[pkCol] = insertId;
                    }
                    row.markFetched();
                }
            }

            // ── 2. UPDATE ────────────────────────────────────────────────────────
            for (const table of dObj.tableNames()) {
                const pkCols = this._pkCols(table);
                for (const row of dObj.getUpdatedRows(table)) {
                    if (!row.isDirty()) continue;
                    const changes = row.toDirtyObject();
                    let q = qb(table).update(changes);  //the actual SQL isn't sent to the database until the query is awaited
                    for (const col of pkCols) q = q.where(col, row.getOriginal(col) ?? row.get(col));
                    await q;
                    row.markFetched();
                }
            }

            // ── 3. DELETE ────────────────────────────────────────────────────────
            const deleteTables = this._topoSort([...dObj.tableNames()], 'DELETE');
            for (const table of deleteTables) {
                // 3a. Row-by-row deletes (deleteRow)
                const pkCols = this._pkCols(table);
                for (const row of dObj.getDeletedRows(table)) {
                    let q = qb(table).delete(); //the actual SQL isn't sent to the database until the query is awaited
                    for (const col of pkCols) q = q.where(col, row.get(col));
                    await q;
                }
                // 3b. Criteria-scoped deletes (deleteRows)
                for (const { criteria } of dObj.getCriteriaDeletes(table)) {
                    let q = qb(table).delete();
                    if (criteria && criteria.length > 0) {
                        applyCriteria(q, criteria);
                    }
                    await q;
                }
            }
        };

        if (trx) {
            await execute(trx);
        } else {
            await knex.transaction(execute);
        }

        return dObj;
    }

    // ── READ — range-scoped (primary API for all entity handler queries) ─────────
    //
    // Two call forms are supported:
    //
    //   Form 1 — SelectQueryImpl (full control):
    //     const sq = new SelectQueryImpl('org_members');
    //     sq.setCriteria(Criteria.eq(Column.getColumn('org_members', 'status'), 'active'));
    //     await dataAccess.get(sq);
    //
    //   Form 2 — shorthand (table name + CriteriaBuilder):
    //     const criteria = new CriteriaBuilder()
    //         .eq('status', 'active')
    //         .between('member_id', rangeStart, rangeEnd)
    //         .build();
    //     await dataAccess.get('org_members', criteria);
    //
    //   In Form 2 the CriteriaBuilder conditions are translated to a Criteria AST
    //   and a SelectQueryImpl (SELECT * FROM <table>) is built internally.
    //   The result is identical to Form 1 with no explicit column selection.
    //
    // get() and getOne() automatically AND the org range BETWEEN onto the query
    // when a RequestContext is active. getRaw() / getOneRaw() skip range injection
    // entirely — use those for IAM tables, OrgContextFilter, and cross-org queries.

    /**
     * Range-scoped SELECT — returns all matching rows.
     * Auto-injects BETWEEN rangeStart AND rangeEnd on the PK when RequestContext is active.
     *
     * @param {SelectQueryImpl|UnionQueryImpl|string} queryOrTable
     *   Pass a SelectQueryImpl / UnionQueryImpl for full control, or a table name string
     *   when using the shorthand form with a CriteriaBuilder array.
     * @param {Array|object} [criteriaOrTrx]
     *   When queryOrTable is a string: the criteria array produced by CriteriaBuilder.build().
     *   When queryOrTable is a SelectQueryImpl: optional Knex transaction object.
     * @param {object} [trx]  optional Knex transaction (shorthand form only)
     * @returns {Promise<Row[]>}
     */
    async get(queryOrTable, criteriaOrTrx, trx) {
        const { selectQuery, transaction } = this._resolveArgs(queryOrTable, criteriaOrTrx, trx);
        const scopedQuery = this._applyScopeIfActive(selectQuery);
        return this._getByQuery(scopedQuery, transaction);
    }

    /**
     * Range-scoped SELECT — returns the first matching row or null.
     * Auto-injects BETWEEN rangeStart AND rangeEnd on the PK when RequestContext is active.
     *
     * @param {SelectQueryImpl|string} queryOrTable
     * @param {Array|object} [criteriaOrTrx]
     * @param {object} [trx]
     * @returns {Promise<Row|null>}
     */
    async getOne(queryOrTable, criteriaOrTrx, trx) {
        const { selectQuery, transaction } = this._resolveArgs(queryOrTable, criteriaOrTrx, trx);
        const scopedQuery = this._applyScopeIfActive(selectQuery);
        return this._getOneByQuery(scopedQuery, transaction);
    }

    /**
     * Unscoped SELECT — returns all matching rows, NO range injection.
     * Use for IAM tables, OrgContextFilter, cross-org admin queries.
     *
     * @param {SelectQueryImpl|UnionQueryImpl|string} queryOrTable
     * @param {Array|object} [criteriaOrTrx]
     * @param {object} [trx]
     * @returns {Promise<Row[]>}
     */
    async getRaw(queryOrTable, criteriaOrTrx, trx) {
        const { selectQuery, transaction } = this._resolveArgs(queryOrTable, criteriaOrTrx, trx);
        return this._getByQuery(selectQuery, transaction);
    }

    /**
     * Unscoped SELECT — returns first row or null, NO range injection.
     * Use for IAM tables, OrgContextFilter, cross-org admin queries.
     *
     * @param {SelectQueryImpl|string} queryOrTable
     * @param {Array|object} [criteriaOrTrx]
     * @param {object} [trx]
     * @returns {Promise<Row|null>}
     */
    async getOneRaw(queryOrTable, criteriaOrTrx, trx) {
        const { selectQuery, transaction } = this._resolveArgs(queryOrTable, criteriaOrTrx, trx);
        return this._getOneByQuery(selectQuery, transaction);
    }

    // ── Private: argument resolver ────────────────────────────────────────────

    /**
     * Resolves the two supported call forms into a canonical { selectQuery, transaction }.
     *
     * Form 1 — query object:
     *   _resolveArgs(selectQueryImpl, trx)
     *   _resolveArgs(unionQueryImpl,  trx)
     *
     * Form 2 — shorthand (table + CriteriaBuilder output):
     *   _resolveArgs('org_members', criteriaArray, trx)
     *
     *   criteriaArray must be the array produced by CriteriaBuilder.build():
     *     [{ column, operator, value, join }, ...]
     *
     *   Each condition is translated to a Criteria AST node and combined with
     *   AND (default) or OR (when condition.join === 'or').
     *   The resulting Criteria tree is set on a fresh SELECT * FROM <table> query.
     *
     * Throws a clear error if:
     *   - A raw JSON array is passed as the first argument (unsupported).
     *   - The first argument is neither a SelectQueryImpl, UnionQueryImpl, nor a string.
     *   - The second argument (criteria) is not a plain array.
     *
     * @param {SelectQueryImpl|UnionQueryImpl|string} queryOrTable
     * @param {Array|object|undefined}                criteriaOrTrx
     * @param {object|undefined}                      trx
     * @returns {{ selectQuery: SelectQueryImpl|UnionQueryImpl, transaction: object|undefined }}
     */
    _resolveArgs(queryOrTable, criteriaOrTrx, trx) {
        // ── Form 1: first arg is a query object ──────────────────────────────
        if (queryOrTable instanceof SelectQueryImpl || queryOrTable instanceof UnionQueryImpl) {
            return { selectQuery: queryOrTable, transaction: criteriaOrTrx };
        }

        // ── Guard: reject plain array as first arg ───────────────────────────
        if (Array.isArray(queryOrTable)) {
            throw new Error(
                '[DataAccess] Passing a plain array as the first argument is not supported. ' +
                'Use a SelectQueryImpl, or pass a table name string with a CriteriaBuilder array: ' +
                'dataAccess.get(\'table\', new CriteriaBuilder().eq(...).build())'
            );
        }

        // ── Form 2: first arg is a table name string ─────────────────────────
        if (typeof queryOrTable === 'string') {
            const tableName    = queryOrTable;
            const criteriaArr  = criteriaOrTrx;
            const transaction  = trx;

            if (criteriaArr !== undefined && !Array.isArray(criteriaArr)) {
                throw new Error(
                    `[DataAccess] When calling get('${tableName}', criteria), ` +
                    'criteria must be the array returned by CriteriaBuilder.build(). ' +
                    `Received: ${typeof criteriaArr}`
                );
            }

            const sq = new SelectQueryImpl(tableName);

            if (criteriaArr && criteriaArr.length > 0) {
                sq.setCriteria(this._criteriaArrayToAST(criteriaArr, tableName));
            }

            return { selectQuery: sq, transaction };
        }

        // ── Unsupported type ─────────────────────────────────────────────────
        throw new Error(
            '[DataAccess] First argument must be a SelectQueryImpl, UnionQueryImpl, or a table name string. ' +
            `Received: ${typeof queryOrTable}`
        );
    }

    /**
     * Translates a CriteriaBuilder output array into a Criteria AST tree.
     *
     * Each element in the array:
     *   { column: string, operator: string, value: any, join: 'and'|'or' }
     *
     * Operator names match ORM CriteriaBuilder keys:
     *   eq, neq, gt, gte, lt, lte, in, notIn, like, startsWith,
     *   isNull, notNull, between, notBetween
     *
     * The plain string column name from the CriteriaBuilder condition is wrapped
     * into a Column object (table = null, columnName = column) so that
     * QueryExecutor.columnRef() can render it correctly as a bare column name
     * (no table prefix) in the generated SQL.
     *
     * Conditions are combined left-to-right:
     *   - join === 'or'  → node.or(next)
     *   - otherwise      → node.and(next)  (default)
     *
     * @param {Array<{ column: string, operator: string, value: any, join: string }>} conditions
     * @param {string} tableName — the base table name (used to wrap plain string columns)
     * @returns {Criteria}
     */
    _criteriaArrayToAST(conditions, tableName) {
        // Wrap a plain string column name into a Column object so QueryExecutor
        // can render it. We pass tableName so the generated SQL uses
        // "tableName.columnName" which avoids ambiguity in single-table queries.
        const col = (name) => Column.getColumn(tableName, name);

        const build = (condition) => {
            const { column, operator, value } = condition;
            const c = col(column);
            switch (operator) {
                case 'eq':          return Criteria.eq(c, value);
                case 'neq':         return Criteria.neq(c, value);
                case 'gt':          return Criteria.gt(c, value);
                case 'gte':         return Criteria.gte(c, value);
                case 'lt':          return Criteria.lt(c, value);
                case 'lte':         return Criteria.lte(c, value);
                case 'in':          return Criteria.in(c, value);
                case 'notIn':       return Criteria.notIn(c, value);
                case 'like':        return Criteria.like(c, value);
                case 'startsWith':  return Criteria.startsWith(c, value);
                case 'isNull':      return Criteria.isNull(c);
                case 'notNull':     return Criteria.isNotNull(c);
                case 'between':     return Criteria.between(c, value[0], value[1]);
                case 'notBetween':  return Criteria.notBetween(c, value[0], value[1]);
                default:
                    throw new Error(
                        `[DataAccess] _criteriaArrayToAST: unknown operator "${operator}". ` +
                        'Use a CriteriaBuilder to build criteria — do not construct condition ' +
                        'objects manually with unsupported operator names.'
                    );
            }
        };

        let root = build(conditions[0]);
        for (let i = 1; i < conditions.length; i++) {
            const node = build(conditions[i]);
            root = conditions[i].join === 'or' ? root.or(node) : root.and(node);
        }
        return root;
    }

    // ── Private: query execution ──────────────────────────────────────────────

    /**
     * Executes a SelectQueryImpl and returns a DataObject when the query has joins
     * with columns selected from multiple tables, or a Row[] for simple single-table
     * queries (no joins, or joins with no columns selected from joined tables).
     *
     * Result shape decision:
     *   - Simple query (no joins, or SELECT * with joins, or only base-table cols):
     *       Returns Row[]  — same as before, rows keyed by base table.
     *   - Multi-table query (joined tables also have columns selected):
     *       Returns DataObject — rows split per table so callers can use
     *       dobj.getRows('roles'), dobj.getRows('user_roles'), etc.
     *
     * Before execution the query is validated: for every joined table that has
     * at least one column selected (i.e. whose rows will be read back), its PK
     * column must also be selected — otherwise DataObject.diff() and row-matching
     * cannot work correctly.
     *
     * @param {SelectQueryImpl|UnionQueryImpl} selectQuery
     * @param {object} [trx]
     * @returns {Promise<Row[]|DataObject>}
     */
    async _getByQuery(selectQuery, trx) {
        if (selectQuery instanceof SelectQueryImpl) {
            this._validateSelectedTablePKs(selectQuery);
        }

        const rawRows = await QueryExecutor.execute(selectQuery, trx || knex);

        // Union queries → flat Row[] keyed by left side's base table
        if (!(selectQuery instanceof SelectQueryImpl)) {
            const tableName = selectQuery.leftQuery?.baseTable?.name ?? null;
            return rawRows.map(r => this._rawToRow(tableName, r));
        }

        const tableColumnMap = this._buildTableColumnMap(selectQuery);

        // Single-table (no joins, SELECT *, or only base-table cols selected) → flat Row[]
        if (tableColumnMap === null) {
            const tableName = selectQuery.baseTable.name;
            return rawRows.map(r => this._rawToRow(tableName, r));
        }

        // Multi-table: split each raw result row into per-table Rows inside a DataObject
        const dataObject = this.constructDataObject();
        for (const rawRow of rawRows) {
            this._splitRawRowIntoDataObject(rawRow, tableColumnMap, dataObject);
        }
        return dataObject;
    }

    /**
     * Same as _getByQuery but returns a single result.
     *
     * Returns:
     *   - null          — no rows matched
     *   - Row           — simple single-table query
     *   - DataObject    — multi-table query (joined tables have selected columns)
     *
     * @param {SelectQueryImpl} selectQuery
     * @param {object} [trx]
     * @returns {Promise<Row|DataObject|null>}
     */
    async _getOneByQuery(selectQuery, trx) {
        if (selectQuery instanceof SelectQueryImpl) {
            this._validateSelectedTablePKs(selectQuery);
        }

        const rawRows = await QueryExecutor.execute(selectQuery, trx || knex);
        if (!rawRows || rawRows.length === 0) return null;

        const tableColumnMap = this._buildTableColumnMap(selectQuery);

        // Single-table query → single Row
        if (tableColumnMap === null) {
            return this._rawToRow(selectQuery.baseTable.name, rawRows[0]);
        }

        // Multi-table: split the first raw row into per-table Rows inside a DataObject
        const dataObject = this.constructDataObject();
        this._splitRawRowIntoDataObject(rawRows[0], tableColumnMap, dataObject);
        return dataObject;
    }

    // ── Private: row construction from query results ──────────────────────────

    /**
     * Constructs a typed, dirty-tracked Row from a raw Knex result object.
     *
     * Uses newRow() + row.set() for each column so that:
     *   - SchemaRegistry type coercions are applied (BIGINT → Number, etc.)
     *   - The _current map is populated via the normal set() path
     *   - markFetched() is called at the end so isDirty() returns false
     *
     * This is the only correct way to construct a Row from DB query results.
     *
     * @param {string} tableName
     * @param {object} rawObj  — plain JS object from QueryExecutor / Knex
     * @returns {Row}
     */
    _rawToRow(tableName, rawObj) {
        const row = this.newRow(tableName);
        for (const [col, val] of Object.entries(rawObj)) {
            row.set(col, val);
        }
        row.markFetched();
        return row;
    }

    /**
     * Splits a single raw Knex result object into per-table Rows registered
     * inside a DataObject, using the column→table mapping from _buildTableColumnMap.
     *
     * Each column key in rawObj is looked up in the tableColumnMap to decide
     * which table it belongs to. Only columns that were explicitly selected
     * (and therefore appear in the map) are included in the split Rows.
     *
     * @param {object}                  rawRow
     * @param {Map<string, string[]>}   tableColumnMap  — from _buildTableColumnMap()
     * @param {DataObject}              dataObject
     */
    _splitRawRowIntoDataObject(rawRow, tableColumnMap, dataObject) {
        for (const [tableName, colNames] of tableColumnMap) {
            const row = this.newRow(tableName);
            let   hasAny = false;
            for (const col of colNames) {
                if (Object.prototype.hasOwnProperty.call(rawRow, col)) {
                    row.set(col, rawRow[col]);
                    hasAny = true;
                }
            }
            if (hasAny) {
                row.markFetched();
                dataObject.addRow(row);
            }
        }
    }

    // ── Private: multi-table result helpers ───────────────────────────────────

    /**
     * Analyses a SelectQueryImpl's selected columns and returns a Map that groups
     * the columns by their owning table (real table name → [columnNames]).
     *
     * Returns null when the query is effectively single-table:
     *   - No joins at all
     *   - SELECT * (no explicit columns)
     *   - All explicit columns belong only to the base table
     *
     * When non-null the Map always contains the base table entry too, so the
     * caller can iterate it uniformly over all tables whose rows must be read.
     *
     * @param {SelectQueryImpl} selectQuery
     * @returns {Map<string, string[]> | null}
     */
    _buildTableColumnMap(selectQuery) {
        const joins = selectQuery.joins;
        if (!joins || joins.length === 0) return null;

        const cols = selectQuery.selectColumns;
        if (cols.length === 0) return null; // SELECT * — treat as single-table

        const hasWildcard = cols.some(c => c.columnName === '*');
        if (hasWildcard) return null;

        // Map alias → real table name for quick lookup
        const aliasToName = new Map();
        aliasToName.set(selectQuery.baseTable.alias || selectQuery.baseTable.name, selectQuery.baseTable.name);
        aliasToName.set(selectQuery.baseTable.name, selectQuery.baseTable.name);
        for (const join of joins) {
            aliasToName.set(join.referencedTable.alias || join.referencedTable.name, join.referencedTable.name);
            aliasToName.set(join.referencedTable.name, join.referencedTable.name);
        }

        // Accumulate columns per real table name
        const tableColMap = new Map(); // realTableName → Set<columnName>
        for (const col of cols) {
            const alias    = col.table ? (col.table.alias || col.table.name) : null;
            const realName = alias ? (aliasToName.get(alias) ?? alias) : selectQuery.baseTable.name;
            if (!tableColMap.has(realName)) tableColMap.set(realName, new Set());
            tableColMap.get(realName).add(col.columnAlias || col.columnName);
        }

        // If only the base table has columns selected → no multi-table split needed
        const tablesWithCols = [...tableColMap.keys()];
        const baseTableName  = selectQuery.baseTable.name;
        const hasJoinedCols  = tablesWithCols.some(t => t !== baseTableName);
        if (!hasJoinedCols) return null;

        // Convert Sets to arrays for consumption
        const result = new Map();
        for (const [t, colSet] of tableColMap) result.set(t, [...colSet]);
        return result;
    }

    /**
     * Validates that every joined table that has at least one column selected
     * (i.e. whose rows will be read back via the DataObject) also has its PK
     * column selected.
     *
     * Rule:
     *   You only need to select a table's PK if you intend to read its rows back
     *   via dobj.getRows(tableName). Joins used purely for filtering (no columns
     *   selected from the joined table) are ignored — they will NOT appear in the
     *   returned DataObject and require no PK.
     *
     *   For tables whose rows ARE read back, the PK must be present so that
     *   DataObject.diff() and any row-matching logic can identify rows correctly.
     *
     * Emits a DEV-WARN (not a throw) to avoid breaking filter-only join patterns.
     *
     * @param {SelectQueryImpl} selectQuery
     */
    _validateSelectedTablePKs(selectQuery) {
        const tableColumnMap = this._buildTableColumnMap(selectQuery);
        if (tableColumnMap === null) return; // single-table or SELECT * — nothing to validate

        const baseTableName = selectQuery.baseTable.name;

        for (const [tableName, colNames] of tableColumnMap) {
            if (tableName === baseTableName) continue; // base table exempt

            const pk = SchemaRegistry.getPrimaryKey(tableName);
            if (!pk) continue; // no PK registered — can't validate, skip silently

            const pkSelected = colNames.includes(pk);
            if (!pkSelected) {
                // Find the alias used in the query so the hint is copy-pasteable
                const join     = selectQuery.joins.find(j => j.referencedTable.name === tableName);
                const alias    = join ? (join.referencedTable.alias || join.referencedTable.name) : tableName;
                console.warn(
                    `[DataAccess] DEV-WARN: table "${tableName}" has columns selected but its PK ` +
                    `"${pk}" is not among them. DataObject row-matching (diff/getRows) may be ` +
                    `incorrect. Add: sq.addSelectColumn(Column.getColumn('${alias}', '${pk}'))`
                );
            }
        }
    }

    // ── Private: range injection ──────────────────────────────────────────────

    /**
     * Clones selectQuery and appends the org range criteria when RequestContext
     * is active. Returns the original query unchanged if no context is active
     * (so callers outside a RequestContext.run() scope still work normally).
     *
     * Only SelectQueryImpl queries are scoped — UnionQueryImpl is returned as-is
     * because its range scoping must be applied per-side by the caller.
     *
     * @param {SelectQueryImpl|UnionQueryImpl} selectQuery
     * @returns {SelectQueryImpl|UnionQueryImpl}
     */
    _applyScopeIfActive(selectQuery) {
        // UnionQueryImpl — don't attempt automatic scoping
        if (!(selectQuery instanceof SelectQueryImpl)) return selectQuery;

        const rangeStart = RequestContext.getRangeStart();
        const rangeEnd   = RequestContext.getRangeEnd();

        // No active org context (IAM route, timer, test) — pass through unchanged
        if (rangeStart == null || rangeEnd == null) return selectQuery;

        // Resolve the PK column for the base table from SchemaRegistry
        const tableName = selectQuery.baseTable.name;
        const pkColumn  = SchemaRegistry.getPrimaryKey(tableName);

        if (!pkColumn) {
            // Table has no registered PK (e.g. join-only table) — cannot scope, pass through
            console.warn(`[DataAccess] _applyScopeIfActive: no PK found for table "${tableName}" — range not applied`);
            return selectQuery;
        }

        // Clone so the caller's original query object is never mutated
        const scoped        = selectQuery.deepClone();
        const rangeCriteria = Criteria.between(
            Column.getColumn(tableName, pkColumn),
            rangeStart,
            rangeEnd
        );

        // AND the range onto whatever criteria the caller already set
        scoped.setCriteria(
            scoped.criteria
                ? scoped.criteria.and(rangeCriteria)
                : rangeCriteria
        );

        return scoped;
    }

    /**
     * Raw JOIN query — no range injection.
     * Kept for legacy callers that build join specs as plain objects.
     * Prefer building a SelectQueryImpl with addJoin() for new code.
     *
     * @param {{ from: string, joins: Array<{table,on,type}> }} joinSpec
     * @param {Array}   criteria  legacy flat-array criteria
     * @param {Array}   columns
     * @param {object}  trx
     */
    async getWithJoin(joinSpec, criteria, columns, trx) {
        const qb = trx || knex;
        const q  = qb(joinSpec.from).select(columns || '*');
        for (const j of (joinSpec.joins || [])) {
            const method = (j.type || 'inner') + 'Join';
            q[method](j.table, j.on[0], j.on[1]);
        }
        if (criteria && criteria.length > 0) applyCriteria(q, criteria);
        return q;
    }

    // ── WRITE — query object model (primary) ──────────────────────────────────

    async update(queryOrDataObject, trx) {
        if (queryOrDataObject instanceof UpdateQueryImpl) {
            return this._updateByQuery(queryOrDataObject, trx);
        }
        return this._updateDataObject(queryOrDataObject, trx);
    }

    async delete(queryOrDataObject, trx) {
        if (queryOrDataObject instanceof DeleteQueryImpl) {
            return this._deleteByQuery(queryOrDataObject, trx);
        }
        return this._deleteDataObject(queryOrDataObject, trx);
    }

    async insert(queryOrTable, objOrUndefined, trx) {
        if (queryOrTable instanceof InsertQueryImpl) {
            return this._insertByQuery(queryOrTable, trx);
        }
        const qb = trx || knex;
        await qb(queryOrTable).insert(objOrUndefined);
    }

    async _updateByQuery(updateQuery, trx) {
        return QueryExecutor.execute(updateQuery, trx || knex);
    }

    async _deleteByQuery(deleteQuery, trx) {
        return QueryExecutor.execute(deleteQuery, trx || knex);
    }

    async _insertByQuery(insertQuery, trx) {
        return QueryExecutor.execute(insertQuery, trx || knex);
    }

    // ── WRITE — DataObject unit-of-work (multi-table transactions) ────────────

    async add(dataObject, trx) {
        const tables     = [...dataObject.tableNames()];
        const writeOrder = this._topoSort(tables, 'INSERT');

        const execute = async (qb) => {
            for (const table of writeOrder) {
                // Resolve the PK column for this table — needed to back-fill
                // AUTO_INCREMENT-generated IDs onto the Row after INSERT.
                const pkCol = SchemaRegistry.getPrimaryKey(table);

                for (const row of dataObject.getAddedRows(table)) {
                    // toResolvedObject() replaces any RowRef FK placeholders with the
                    // real PK values of already-inserted parent rows. Throws if a parent
                    // has not been inserted yet (dependency order violation).
                    const resolved = row.toResolvedObject();

                    // Knex returns [insertId] for AUTO_INCREMENT tables; 0 for others.
                    const [insertId] = await qb(table).insert(resolved);

                    // Back-fill the generated PK onto the Row so that:
                    //   1. row.get(pkCol) returns the real value after add() returns
                    //   2. Any RowRef created from this row (in child rows of a deeper
                    //      chain) resolves correctly when the next iteration calls
                    //      toResolvedObject() on the child.
                    if (pkCol && insertId && !row._current[pkCol]) {
                        row._current[pkCol] = insertId;
                    }

                    row.markFetched();
                }
            }
        };

        if (trx) {
            await execute(trx);
        } else {
            await knex.transaction(execute);
        }

        return dataObject;
    }

    async _updateDataObject(dataObject, trx) {
        const tables = [...dataObject.tableNames()];

        const execute = async (qb) => {
            for (const table of tables) {
                const pkCols = this._pkCols(table);
                for (const row of dataObject.getUpdatedRows(table)) {
                    if (!row.isDirty()) continue;
                    const changes = row.toDirtyObject();
                    let q = qb(table).update(changes);
                    for (const col of pkCols) q = q.where(col, row.getOriginal(col) ?? row.get(col));
                    await q;
                    row.markFetched();
                }
            }
        };

        if (trx) {
            await execute(trx);
        } else {
            await knex.transaction(execute);
        }

        return dataObject;
    }

    async _deleteDataObject(dataObject, trx) {
        const tables     = [...dataObject.tableNames()];
        const writeOrder = this._topoSort(tables, 'DELETE');

        const execute = async (qb) => {
            for (const table of writeOrder) {
                // ── Row-by-row deletes — deleteRow(row) ──────────────────────────
                // Each staged row contributes one DELETE WHERE pk = ? statement.
                const pkCols = this._pkCols(table);
                for (const row of dataObject.getDeletedRows(table)) {
                    let q = qb(table).delete();
                    for (const col of pkCols) q = q.where(col, row.get(col));
                    await q;
                }

                // ── Criteria-scoped deletes — deleteRows(table, criteria) ─────────
                // Each deleteRows() call contributes one DELETE WHERE <criteria> statement.
                // No rows need to be fetched first — the criteria builds the WHERE clause.
                for (const { criteria } of dataObject.getCriteriaDeletes(table)) {
                    let q = qb(table).delete();
                    if (criteria && criteria.length > 0) {
                        applyCriteria(q, criteria);
                    }
                    await q;
                }
            }
        };

        if (trx) {
            await execute(trx);
        } else {
            await knex.transaction(execute);
        }

        return dataObject;
    }

    // ── Upsert (direct, no InsertQueryImpl wrapping needed for simple cases) ──
    //If a row already exists with matching conflictColumns values, .ignore() causes the insert to be silently skipped (no error, no update) — i.e., "insert if not exists" semantics rather than a true insert-or-update upsert.
    async upsert(table, obj, conflictColumns, trx) {
        const qb = trx || knex;
        await qb(table).insert(obj).onConflict(conflictColumns).ignore();
    }

    // ── Transaction wrapper ───────────────────────────────────────────────────

    transaction(callback) {
        return knex.transaction(callback);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    _topoSort(tables, direction) {
        const tableSet = new Set(tables);
        const adj      = new Map();
        for (const t of tables) adj.set(t, new Set());

        for (const child of tables) {
            const fks = SchemaRegistry.getForeignKeys(child);
            for (const fk of fks) {
                if (tableSet.has(fk.refTable)) {
                    adj.get(fk.refTable).add(child);
                }
            }
        }

        const visited = new Set();
        const order   = [];

        const visit = (node) => {
            if (visited.has(node)) return;
            visited.add(node);
            for (const dep of (adj.get(node) ?? [])) visit(dep);
            order.push(node);
        };

        for (const t of tables) visit(t);

        const sorted = order.reverse();
        return direction === 'DELETE' ? sorted.reverse() : sorted;
    }

    _pkCols(table) {
        try {
            const defs = SchemaRegistry.get(table);
            return Object.entries(defs)
                .filter(([, d]) => d.primaryKey)
                .map(([col]) => col);
        } catch (_) {
            return [];
        }
    }
}

module.exports = new DataAccess();
