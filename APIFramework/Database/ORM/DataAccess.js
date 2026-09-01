'use strict';

const knex              = require('../KnexClient');
const SchemaRegistry    = require('./SchemaRegistry');
const Row               = require('./Row');
const DataObject        = require('./DataObject');
const { applyCriteria } = require('./Criteria');
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

    // ── PersistenceUtil-style helpers (mirrors SDP PersistenceUtil.addChildRowIntoDO) ──
    //
    // SDP pattern:
    //   DataObject dObj = DataAccessUtil.getInstance().constructDataObject();
    //   Row row = new Row(tableName);
    //   PersistenceUtil.addChildRowIntoDO(dObj, row);          // ADD
    //   PersistenceUtil.updateChildRowIntoDO(dObj, row);       // UPDATE
    //   PersistenceUtil.deleteChildRowIntoDO(dObj, row);       // DELETE
    //
    // Versatile equivalent — all three operations on a single DataObject:
    //   const dObj = dataAccess.constructDataObject();
    //   const row  = dataAccess.newRow('roles');
    //   row.set('name', 'Viewer');
    //   dataAccess.addChildRowIntoDO(dObj, row);               // ADD
    //   dataAccess.updateChildRowIntoDO(dObj, existingRow);    // UPDATE
    //   dataAccess.deleteChildRowIntoDO(dObj, existingRow);    // DELETE
    //   await dataAccess.add(dObj);      // flush ADD rows
    //   await dataAccess.update(dObj);   // flush UPDATE rows
    //   await dataAccess.delete(dObj);   // flush DELETE rows
    //
    // You can also mix ADD + UPDATE + DELETE rows in one DataObject and flush
    // each operation separately, or use dataAccess.persistDataObject(dObj) to
    // flush all three operations in a single transaction.

    /**
     * Registers a Row as an INSERT operation inside the DataObject.
     * Mirrors: PersistenceUtil.addChildRowIntoDO(dObj, row)
     *
     * @param {DataObject} dObj  — the unit-of-work container
     * @param {Row}        row   — the Row to INSERT (must be fully populated)
     */
    addChildRowIntoDO(dObj, row) {
        dObj.addRow(row);
    }

    /**
     * Registers a Row as an UPDATE operation inside the DataObject.
     * Mirrors: PersistenceUtil.updateChildRowIntoDO(dObj, row)
     *
     * Only dirty columns (changed since last markFetched()) will be written.
     *
     * @param {DataObject} dObj  — the unit-of-work container
     * @param {Row}        row   — the Row to UPDATE (must have been fetched first)
     */
    updateChildRowIntoDO(dObj, row) {
        dObj.updateRow(row);
    }

    /**
     * Registers a Row as a DELETE operation inside the DataObject.
     * Mirrors: PersistenceUtil.deleteChildRowIntoDO(dObj, row)
     *
     * @param {DataObject} dObj  — the unit-of-work container
     * @param {Row}        row   — the Row to DELETE (PK must be set)
     */
    deleteChildRowIntoDO(dObj, row) {
        dObj.deleteRow(row);
    }

    /**
     * Flushes ALL pending operations (ADD + UPDATE + DELETE) from a DataObject
     * in a single atomic transaction.
     *
     * Execution order:
     *   1. INSERT  rows (FK-dependency order via topo-sort)
     *   2. UPDATE  rows (only dirty columns)
     *   3. DELETE  rows (reverse FK order)
     *
     * Use this when your handler builds one DataObject with multiple operation
     * types and wants to commit everything in one shot — mirrors the SDP pattern
     * of calling PersistenceUtil.persist(dObj) after all rows are staged.
     *
     * @param {DataObject} dObj
     * @param {object}     trx   — optional Knex transaction (pass from dataAccess.transaction())
     */
    async persistDataObject(dObj, trx) {
        const execute = async (qb) => {
            // ── 1. INSERT ────────────────────────────────────────────────────────
            const insertTables = this._topoSort([...dObj.tableNames()], 'INSERT');
            for (const table of insertTables) {
                const pkCol = SchemaRegistry.getPrimaryKey(table);
                for (const row of dObj.getAddedRows(table)) {
                    const resolved  = row.toResolvedObject();
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
                    let q = qb(table).update(changes);
                    for (const col of pkCols) q = q.where(col, row.getOriginal(col) ?? row.get(col));
                    await q;
                    row.markFetched();
                }
            }

            // ── 3. DELETE ────────────────────────────────────────────────────────
            const deleteTables = this._topoSort([...dObj.tableNames()], 'DELETE');
            for (const table of deleteTables) {
                const pkCols = this._pkCols(table);
                for (const row of dObj.getDeletedRows(table)) {
                    let q = qb(table).delete();
                    for (const col of pkCols) q = q.where(col, row.get(col));
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
    // get()    and getOne()    automatically AND the org range criteria onto any
    // SelectQueryImpl that is passed in, when a RequestContext is active.
    //
    // How it works:
    //   1. Reads rangeStart / rangeEnd from RequestContext (ALS — zero param passing)
    //   2. Resolves the PK column for the query's base table from SchemaRegistry
    //   3. Clones the query and appends:
    //        WHERE <pk> BETWEEN rangeStart AND rangeEnd
    //      combined with whatever criteria the caller already set
    //   4. Executes the scoped clone — the original query object is never mutated
    //
    // When NOT to use:
    //   IAM routes, OrgContextFilter internals, SequenceGenerator, SchemaBuilder,
    //   or any query that intentionally spans all orgs (e.g. email uniqueness check).
    //   Use getRaw() / getOneRaw() for those — they skip range injection entirely.
    //
    // ── getRaw()    and getOneRaw() bypass range injection completely ──────────
    // Use these when:
    //   - Querying framework/IAM tables (iam_auth_accounts, organizations, token_blacklist)
    //   - Inside OrgContextFilter itself (resolving org/member/roles)
    //   - Any cross-org admin query (future platform-admin features)
    //   - Unit tests that run outside a RequestContext

    /**
     * Range-scoped SELECT — returns all matching rows.
     * Auto-injects BETWEEN rangeStart AND rangeEnd on the PK when RequestContext is active.
     *
     * @param {SelectQueryImpl|UnionQueryImpl} selectQuery
     * @param {object} [trx]  optional Knex transaction
     * @returns {Promise<Row[]>}
     */
    async get(selectQuery, trx) {
        const scopedQuery = this._applyScopeIfActive(selectQuery);
        return this._getByQuery(scopedQuery, trx);
    }

    /**
     * Range-scoped SELECT — returns the first matching row or null.
     * Auto-injects BETWEEN rangeStart AND rangeEnd on the PK when RequestContext is active.
     *
     * @param {SelectQueryImpl} selectQuery
     * @param {object} [trx]  optional Knex transaction
     * @returns {Promise<Row|null>}
     */
    async getOne(selectQuery, trx) {
        const scopedQuery = this._applyScopeIfActive(selectQuery);
        return this._getOneByQuery(scopedQuery, trx);
    }

    /**
     * Unscoped SELECT — returns all matching rows, NO range injection.
     * Use for IAM tables, OrgContextFilter, cross-org admin queries.
     *
     * @param {SelectQueryImpl|UnionQueryImpl} selectQuery
     * @param {object} [trx]  optional Knex transaction
     * @returns {Promise<Row[]>}
     */
    async getRaw(selectQuery, trx) {
        return this._getByQuery(selectQuery, trx);
    }

    /**
     * Unscoped SELECT — returns first row or null, NO range injection.
     * Use for IAM tables, OrgContextFilter, cross-org admin queries.
     *
     * @param {SelectQueryImpl} selectQuery
     * @param {object} [trx]  optional Knex transaction
     * @returns {Promise<Row|null>}
     */
    async getOneRaw(selectQuery, trx) {
        return this._getOneByQuery(selectQuery, trx);
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
                const pkCols = this._pkCols(table);
                for (const row of dataObject.getDeletedRows(table)) {
                    let q = qb(table).delete();
                    for (const col of pkCols) q = q.where(col, row.get(col));
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
