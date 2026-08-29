'use strict';

const Row            = require('./Row');
const SchemaRegistry = require('./SchemaRegistry');

const OP = { ADD: 'ADD', UPDATE: 'UPDATE', DELETE: 'DELETE' };

class DataObject {
    constructor() {
        this._rows      = new Map();
        this._opByRow   = new Map();
    }

    // ── Write classification ──────────────────────────────────────────────────

    addRow(row) {
        this._register(row, OP.ADD);
        return this;
    }

    updateRow(row) {
        this._register(row, OP.UPDATE);
        return this;
    }

    deleteRow(row) {
        this._register(row, OP.DELETE);
        return this;
    }

    _register(row, op) {
        if (!(row instanceof Row)) throw new Error('[DataObject] Only Row instances can be registered.');
        const list = this._rows.get(row.tableName) ?? [];
        list.push(row);
        this._rows.set(row.tableName, list);
        this._opByRow.set(row, op);
    }

    // ── Read access ───────────────────────────────────────────────────────────

    getRows(tableName) {
        return (this._rows.get(tableName) ?? []).values();
    }

    getAddedRows(tableName) {
        return this._filterByOp(tableName, OP.ADD);
    }

    getUpdatedRows(tableName) {
        return this._filterByOp(tableName, OP.UPDATE);
    }

    getDeletedRows(tableName) {
        return this._filterByOp(tableName, OP.DELETE);
    }

    getOperation(row) {
        return this._opByRow.get(row) ?? null;
    }

    tableNames() {
        return this._rows.keys();
    }

    isEmpty() {
        return this._rows.size === 0;
    }

    _filterByOp(tableName, op) {
        return (this._rows.get(tableName) ?? [])
            .filter(r => this._opByRow.get(r) === op)
            .values();
    }

    // ── clone ─────────────────────────────────────────────────────────────────

    clone() {
        const copy = new DataObject();
        for (const [table, rows] of this._rows) {
            const cloned = rows.map(r => r.clone());
            copy._rows.set(table, cloned);
            cloned.forEach((cr, i) => copy._opByRow.set(cr, this._opByRow.get(rows[i])));
        }
        return copy;
    }

    // ── diff ──────────────────────────────────────────────────────────────────
    // Returns a new DataObject classifying rows as ADD / UPDATE / DELETE
    // relative to `base`. Matched by primary-key column values on the Row objects.

    diff(base) {
        const result  = new DataObject();
        const allTables = new Set([...this._rows.keys(), ...base._rows.keys()]);

        for (const table of allTables) {
            const editedRows = [...(this._rows.get(table)  ?? [])];
            const baseRows   = [...(base._rows.get(table)  ?? [])];
            const baseByPk   = this._indexByPk(baseRows);

            for (const row of editedRows) {
                const pkKey  = this._pkKey(row);
                const origin = baseByPk.get(pkKey);
                if (!origin) {
                    result.addRow(row.clone());
                } else {
                    const changedCols = this._changedCols(origin, row);
                    if (changedCols.length > 0) {
                        const partial = new Row(table);
                        for (const col of changedCols) partial.set(col, row.get(col));
                        result.updateRow(partial);
                    }
                }
            }

            const editedByPk = this._indexByPk(editedRows);
            for (const row of baseRows) {
                if (!editedByPk.has(this._pkKey(row))) {
                    result.deleteRow(row.clone());
                }
            }
        }

        return result;
    }

    _pkKey(row) {
        const pkCols = this._getPkCols(row.tableName);
        if (pkCols.length === 0) return JSON.stringify(row.toObject());
        const key = {};
        for (const col of pkCols) key[col] = row.get(col);
        return JSON.stringify(key);
    }

    _getPkCols(tableName) {
        try {
            const defs = SchemaRegistry.get(tableName);
            return Object.entries(defs)
                .filter(([, def]) => def.primaryKey)
                .map(([col]) => col);
        } catch (_) {
            return [];
        }
    }

    _indexByPk(rows) {
        const map = new Map();
        for (const r of rows) map.set(this._pkKey(r), r);
        return map;
    }

    _changedCols(base, edited) {
        const cols = new Set([...Object.keys(base.toObject()), ...Object.keys(edited.toObject())]);
        return [...cols].filter(c => base.get(c) !== edited.get(c));
    }
}

DataObject.OP = OP;

module.exports = DataObject;
