'use strict';

class Table {

    constructor(name, alias) {
        if (!name || typeof name !== 'string') {
            throw new Error('[Table] name must be a non-empty string');
        }
        this.name  = name;
        this.alias = alias || name;
        Object.freeze(this);
    }

    static _cache = new Map();

    static getTable(name, alias) {
        const key = alias ? `${name}\0${alias}` : name;
        if (!Table._cache.has(key)) {
            Table._cache.set(key, new Table(name, alias));
        }
        return Table._cache.get(key);
    }

    static _clearCache() {
        Table._cache.clear();
    }

    toString() {
        return this.alias !== this.name
            ? `${this.name} AS ${this.alias}`
            : this.name;
    }
}

module.exports = Table;
