'use strict';

const Row            = require('./Row');
const SchemaRegistry = require('./SchemaRegistry');

const OP = { ADD: 'ADD', UPDATE: 'UPDATE', DELETE: 'DELETE' };

class DataObject {
    constructor() {
        this._rows      = new Map();   // tableName → Row[]
        this._opByRow   = new Map();   // Track rows operator

        // Stores pending criteria-scoped deletes staged via deleteRows().
        // Shape: Map<tableName, Array<{ criteria: Array }>>
        // Each entry is one deleteRows() call; multiple calls on the same
        // table are accumulated as separate entries (each becomes one DELETE WHERE).
        this._criteriaDeletes = new Map();
    }

    // ── Write classification ──────────────────────────────────────────────────

    /**
     * Stage a Row for INSERT.
     *
     * The RowRef pattern handles parent-child FK dependencies automatically:
     * set the child's FK column to parentRow.get(pkCol) — that returns a RowRef
     * placeholder which DataAccess.add() resolves after the parent INSERT back-fills
     * the real PK. No separate "addChildRowIntoDO" method is needed.
     *
     * @param {Row} row
     * @returns {this}
     */
    addRow(row) {
        this._register(row, OP.ADD);
        return this;
    }

    /**
     * Stage a Row for UPDATE.
     *
     * Only dirty columns (changed since the last markFetched()) are written.
     * The row must have been fetched from the DB first (or previously staged as ADD).
     *
     * @param {Row} row
     * @returns {this}
     */
    updateRow(row) {
        this._register(row, OP.UPDATE);
        return this;
    }

    /**
     * Stage a single known Row instance for DELETE.
     *
     * Use when you already have the exact Row object in hand (e.g. fetched via
     * dataAccess.getOne()). The row's PK column(s) are used to build the
     * DELETE WHERE clause.
     *
     * For removing a set of rows matched by a filter without fetching them first,
     * use deleteRows() instead.
     *
     * @param {Row} row
     * @returns {this}
     */
    deleteRow(row) {
        this._register(row, OP.DELETE);
        return this;
    }

    /**
     * Stage a criteria-scoped DELETE for all rows in a table matching a filter.
     *
     * Unlike deleteRow(), this does NOT require fetching rows first.
     * DataAccess._deleteDataObject() issues a single parameterized
     * DELETE FROM <tableName> WHERE <criteria> for each deleteRows() call.
     *
     * The criteria parameter is the array produced by CriteriaBuilder.build():
     *   dObj.deleteRows('custom_module_values', new CriteriaBuilder()
     *       .eq('module_id', moduleId)
     *       .build()
     *   );
     *
     * Multiple deleteRows() calls on the same table are accumulated — each
     * becomes its own DELETE WHERE statement in the flush.
     *
     * Pass an empty array or omit criteria to delete ALL rows in the table:
     *   dObj.deleteRows('temp_table');   // DELETE FROM temp_table (no WHERE)
     *
     * @param {string}  tableName
     * @param {Array}   [criteria]  — CriteriaBuilder.build() output; omit to delete all
     * @returns {this}
     */
    deleteRows(tableName, criteria = []) {
        if (!Array.isArray(criteria)) {
            throw new Error(
                `[DataObject] deleteRows('${tableName}', criteria): ` +
                'criteria must be the array returned by CriteriaBuilder.build(). ' +
                `Received: ${typeof criteria}`
            );
        }
        const existing = this._criteriaDeletes.get(tableName) ?? [];
        existing.push({ criteria });
        this._criteriaDeletes.set(tableName, existing);

        // Register a sentinel in _rows so tableNames() includes this table and
        // the topo-sort in DataAccess considers it during DELETE ordering.
        // The sentinel is never iterated by getDeletedRows() — only _criteriaDeletes is.
        if (!this._rows.has(tableName)) {
            this._rows.set(tableName, []);
        }

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

    /**
     * Returns an iterator over all rows registered for a table, regardless of operation.
     * Useful for inspecting what is staged without caring whether it is ADD/UPDATE/DELETE.
     *
     * @param {string} tableName
     * @returns {IterableIterator<Row>}
     */
    getRows(tableName) {
        return (this._rows.get(tableName) ?? []).values();
    }

    /**
     * Returns true if any rows (or a criteria delete) have been staged for tableName.
     *
     * Mirrors the `entityDO.containsTable(TABLE)` pattern from the source framework,
     * used by handlers to check whether a table is present before calling getFirstRow()
     * or updateRow():
     *
     *   if (dObj.containsTable('custom_module_values')) {
     *       const row = dObj.getFirstRow('custom_module_values');
     *       row.set('value', newValue);
     *       dObj.updateRow(row);
     *   }
     *
     * @param {string} tableName
     * @returns {boolean}
     */
    containsTable(tableName) {
        return (this._rows.has(tableName) && (this._rows.get(tableName).length > 0))
            || this._criteriaDeletes.has(tableName);
    }

    /**
     * Returns the first Row registered for tableName, or null if none.
     *
     * Mirrors `entityDO.getFirstRow(TABLE)` from the source framework.
     * Typically used after containsTable() confirms the table is present:
     *
     *   const row = dObj.getFirstRow('config');
     *   if (row) {
     *       row.set('param_value', newValue);
     *       dObj.updateRow(row);
     *   }
     *
     * Returns the first row regardless of its staged operation (ADD/UPDATE/DELETE).
     *
     * @param {string} tableName
     * @returns {Row | null}
     */
    getFirstRow(tableName) {
        const rows = this._rows.get(tableName);
        return (rows && rows.length > 0) ? rows[0] : null;
    }

    getAddedRows(tableName) {
        return this._filterByOp(tableName, OP.ADD);
    }

    getUpdatedRows(tableName) {
        return this._filterByOp(tableName, OP.UPDATE);
    }

    /**
     * Returns an iterator over rows staged for row-by-row DELETE via deleteRow().
     * Does NOT include criteria-scoped deletes from deleteRows() — those are
     * handled separately by DataAccess._deleteDataObject() via getCriteriaDeletes().
     *
     * @param {string} tableName
     * @returns {IterableIterator<Row>}
     */
    getDeletedRows(tableName) {
        return this._filterByOp(tableName, OP.DELETE);
    }

    /**
     * Returns all pending criteria-scoped delete entries for a table.
     * Used exclusively by DataAccess._deleteDataObject().
     *
     * @param {string} tableName
     * @returns {Array<{ criteria: Array }>}
     */
    getCriteriaDeletes(tableName) {
        return this._criteriaDeletes.get(tableName) ?? [];
    }

    /**
     * Returns true if there are any criteria-scoped deletes staged for tableName.
     *
     * @param {string} tableName
     * @returns {boolean}
     */
    hasCriteriaDeletes(tableName) {
        return (this._criteriaDeletes.get(tableName) ?? []).length > 0;
    }

    getOperation(row) {
        return this._opByRow.get(row) ?? null;
    }

    tableNames() {
        // Union of row-registered tables and criteria-delete-only tables
        const all = new Set([...this._rows.keys(), ...this._criteriaDeletes.keys()]);
        return all.keys();
    }

    isEmpty() {
        return this._rows.size === 0 && this._criteriaDeletes.size === 0;
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
        // Deep-copy criteria deletes so the clone is fully independent
        for (const [table, entries] of this._criteriaDeletes) {
            copy._criteriaDeletes.set(table, entries.map(e => ({ criteria: [...e.criteria] })));
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
