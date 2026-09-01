'use strict';

const SchemaRegistry = require('./SchemaRegistry');
const RowRef         = require('./RowRef');
const RequestContext  = require('../../Context/RequestContext');

// Dates are stored as MySQL-compatible strings: 'YYYY-MM-DD HH:MM:SS'.
// This avoids locale-specific Date.toString() output which MySQL rejects.
const toMysqlDateStr = v => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(v);
    // toISOString gives 'YYYY-MM-DDTHH:mm:ss.sssZ' — strip to MySQL format YYYY-MM-DD HH:mm:ss
    return d.toISOString().slice(0, 19).replace('T', ' ');
};

const TYPE_COERCIONS = {
    BIGINT:    v => (v === null || v === undefined) ? null : Number(v),
    INT:       v => (v === null || v === undefined) ? null : Number(v),
    INTEGER:   v => (v === null || v === undefined) ? null : Number(v),
    BOOLEAN:   v => (v === null || v === undefined) ? null : Boolean(v),
    VARCHAR:   v => (v === null || v === undefined) ? null : String(v),
    CHAR:      v => (v === null || v === undefined) ? null : String(v),
    TEXT:      v => (v === null || v === undefined) ? null : String(v),
    DATE:      toMysqlDateStr,
    DATETIME:  toMysqlDateStr,
    TIMESTAMP: toMysqlDateStr,
    DECIMAL:   v => (v === null || v === undefined) ? null : parseFloat(v),
    FLOAT:     v => (v === null || v === undefined) ? null : parseFloat(v),
    BLOB:      v => v,
};

function coerce(value, dataType) {
    if (!dataType) return value;
    const fn = TYPE_COERCIONS[dataType.toUpperCase()];
    if (!fn) return value;
    return fn(value);
}

class Row {
    constructor(tableName) {
        this.tableName      = tableName;
        this._current       = {};
        this._original      = {};
        this._dirty         = new Set();
        this._refs          = {};   // cache of RowRef instances keyed by PK column name
    }

    /**
     * Returns the value for a column.
     *
     * Normal path: returns the stored value (including 0 / false / a previously stored RowRef).
     *
     * RowRef placeholder path:
     *   If the column has never been set AND is this row's primary key column (determined
     *   from SchemaRegistry, or from the explicit _pkColumns hint set via markAsPK()), a
     *   cached RowRef is returned instead of null. This lets callers wire parent→child FK
     *   chains in a single DataObject before the parent is inserted:
     *
     *     childRow.set('auth_account_id', parentRow.get('auth_account_id'));
     *       → stores the RowRef; DataAccess.add() resolves it after INSERT back-fills the PK.
     *
     * Falls back to null for non-PK unset columns (unchanged legacy behaviour).
     *
     * @param {string} column
     * @returns {*|RowRef|null}
     */
    get(column) {
        // If we have a real value (including 0 / false), return it.
        // Also covers: RowRef already stored in _current (FK column on child row).
        const val = this._current[column];
        if (val !== undefined && val !== null) return val;

        // PK column that was never set → return a cached RowRef placeholder.
        // Two detection strategies (first match wins):
        //   1. Explicit hint — caller called row.markAsPK(colName) (used when SchemaRegistry
        //      is not yet populated, e.g. IAM tables loaded before the DD parse step).
        //   2. SchemaRegistry — available after boot for all DD-registered tables.
        const isPK = (this._pkColumns && this._pkColumns.has(column))
                  || (this._getColDef(column)?.primaryKey === true);

        if (isPK) {
            // Does this PK column have a <uniquevalue-generation> generator declared?
            // If yes → org-scoped SequenceGenerator path: eagerly reserve a real ID now.
            // If no  → AUTO_INCREMENT path: return a RowRef placeholder; real value comes
            //          from MySQL insertId after DataAccess.add() fires the INSERT.
            const generatorName = SchemaRegistry.getGeneratorName(this.tableName, column);
            if (generatorName) {
                // Lazy-require to avoid circular dependency at module load time
                // (Row → SequenceGenerator → KnexClient; all fine at runtime)
                const SequenceGenerator = require('../SequenceGenerator');
                const orgId = RequestContext.getOrgId();
                if (!orgId) {
                    throw new Error(
                        `[Row] Cannot auto-generate PK "${column}" on table "${this.tableName}": ` +
                        `no active RequestContext (orgId is null). ` +
                        `Ensure Row.get() is called inside a RequestContext.run() scope, ` +
                        `or set the PK explicitly via row.set() for seeding/migration contexts.`
                    );
                }
                // Eagerly generate and cache the real ID — same approach as SDP's Row.get()
                // which calls SequenceGenerator.nextValue() on the hot path.
                const id = SequenceGenerator.getNextIdSync(orgId);
                this._current[column] = id;
                return id;
            }

            // AUTO_INCREMENT — return a cached RowRef placeholder
            if (!this._refs[column]) {
                this._refs[column] = new RowRef(this, column);
            }
            return this._refs[column];
        }

        return null;
    }

    /**
     * Explicitly marks one or more column names as PK columns for this Row.
     *
     * Use this for tables whose schema is not yet registered in SchemaRegistry
     * at the time get() is called (e.g. IAM tables used during early boot, or
     * in unit tests that run without a full DataDictionary parse).
     *
     * @param {...string} columns
     * @returns {this}
     */
    markAsPK(...columns) {
        if (!this._pkColumns) this._pkColumns = new Set();
        for (const col of columns) this._pkColumns.add(col);
        return this;
    }

    /**
     * Sets a column value with type coercion.
     *
     * Accepts RowRef values (FK placeholders) — stored as-is without coercion.
     * DataAccess.add() resolves them via toResolvedObject() before INSERT.
     *
     * @param {string} column
     * @param {*|RowRef} value
     * @returns {this}
     */
    set(column, value) {
        // RowRef placeholders are stored without coercion — they carry no real value yet.
        if (value instanceof RowRef) {
            if (this._current[column] !== value) {
                this._dirty.add(column);
            }
            this._current[column] = value;
            return this;
        }

        const colDef   = this._getColDef(column);
        const dataType = colDef ? colDef.type : null; // null → no coercion, pass value as-is
        const coerced  = coerce(value, dataType);

        if (this._current[column] !== coerced) {
            this._dirty.add(column);
        }
        this._current[column] = coerced;
        return this;
    }

    getOriginal(column) {
        return this._original[column] ?? null;
    }

    isDirty(column) {
        if (column !== undefined) return this._dirty.has(column);
        return this._dirty.size > 0;
    }

    getDirtyColumns() {
        return new Set(this._dirty);
    }

    markFetched() {
        this._original = { ...this._current };
        this._dirty.clear();
        return this;
    }

    toObject() {
        return { ...this._current };
    }

    /**
     * Like toObject() but resolves any RowRef placeholders to their real values.
     *
     * Called by DataAccess.add() just before each INSERT so that FK columns
     * that were set from a parent RowRef carry the parent's now-generated PK.
     *
     * Throws if a RowRef has not yet been resolved (parent not yet inserted).
     *
     * @returns {{ [col: string]: * }}
     */
    toResolvedObject() {
        const out = {};
        for (const [col, val] of Object.entries(this._current)) {
            out[col] = (val instanceof RowRef) ? val.resolve() : val;
        }
        return out;
    }

    toDirtyObject() {
        const out = {};
        for (const col of this._dirty) {
            out[col] = this._current[col];
        }
        return out;
    }

    clone() {
        const r        = new Row(this.tableName);
        r._current     = { ...this._current };
        r._original    = { ...this._original };
        r._dirty       = new Set(this._dirty);
        return r;
    }

    _getColDef(column) {
        try {
            const defs = SchemaRegistry.get(this.tableName);
            return defs[column] || null;
        } catch (_) {
            return null;
        }
    }
}

module.exports = Row;
