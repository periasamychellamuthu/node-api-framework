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

class DataAccess {

    constructDataObject() {
        return new DataObject();
    }

    newRow(tableName) {
        return new Row(tableName);
    }

    // ── READ — query object model (primary) ───────────────────────────────────

    async get(queryOrTable, criteriaOrColumns, columns, trx) {
        if (queryOrTable instanceof SelectQueryImpl || queryOrTable instanceof UnionQueryImpl) {
            // When called as get(queryImpl, trx) the trx lands in criteriaOrColumns
            const resolvedTrx = (criteriaOrColumns && typeof criteriaOrColumns.commit === 'function')
                ? criteriaOrColumns
                : trx;
            return this._getByQuery(queryOrTable, resolvedTrx);
        }
        return this._getLegacy(queryOrTable, criteriaOrColumns, columns, trx);
    }

    async getOne(queryOrTable, criteriaOrColumns, columns, trx) {
        if (queryOrTable instanceof SelectQueryImpl) {
            // When called as getOne(queryImpl, trx) the trx lands in criteriaOrColumns
            const resolvedTrx = (criteriaOrColumns && typeof criteriaOrColumns.commit === 'function')
                ? criteriaOrColumns
                : trx;
            return this._getOneByQuery(queryOrTable, resolvedTrx);
        }
        return this._getOneLegacy(queryOrTable, criteriaOrColumns, columns, trx);
    }

    async _getByQuery(selectQuery, trx) {
        const tableName = selectQuery.baseTable
            ? selectQuery.baseTable.name
            : (selectQuery.leftQuery ? selectQuery.leftQuery.baseTable.name : null);

        const rows = await QueryExecutor.execute(selectQuery, trx || knex);
        return rows.map(r => Row.fromObject(tableName, r));
    }

    async _getOneByQuery(selectQuery, trx) {
        const tableName = selectQuery.baseTable.name;
        const rows      = await QueryExecutor.execute(selectQuery, trx || knex);
        if (!rows || rows.length === 0) return null;
        return Row.fromObject(tableName, rows[0]);
    }

    // ── READ — legacy flat-array criteria (backward compat) ───────────────────

    async _getLegacy(table, criteria, columns, trx) {
        const qb   = trx || knex;
        const cols = columns || '*';
        const q    = qb(table).select(cols);
        if (criteria && criteria.length > 0) applyCriteria(q, criteria);
        const rows = await q;
        return rows.map(r => Row.fromObject(table, r));
    }

    async _getOneLegacy(table, criteria, columns, trx) {
        const qb   = trx || knex;
        const cols = columns || '*';
        const q    = qb(table).select(cols);
        if (criteria && criteria.length > 0) applyCriteria(q, criteria);
        const row = await q.first();
        return row ? Row.fromObject(table, row) : null;
    }

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
                for (const row of dataObject.getAddedRows(table)) {
                    await qb(table).insert(row.toObject());
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
