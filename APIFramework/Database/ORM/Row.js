'use strict';

const SchemaRegistry = require('./SchemaRegistry');

// Dates are stored as MySQL-compatible strings: 'YYYY-MM-DD HH:MM:SS'.
// This avoids locale-specific Date.toString() output which MySQL rejects.
const toMysqlDateStr = v => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(v);
    // toISOString gives 'YYYY-MM-DDTHH:mm:ss.sssZ' — strip to MySQL format
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
    }

    get(column) {
        return this._current[column] ?? null;
    }

    set(column, value) {
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

    toDirtyObject() {
        const out = {};
        for (const col of this._dirty) {
            out[col] = this._current[col];
        }
        return out;
    }

    static fromObject(tableName, obj) {
        const row = new Row(tableName);
        for (const [k, v] of Object.entries(obj)) {
            row._current[k] = v;
        }
        row.markFetched();
        return row;
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
