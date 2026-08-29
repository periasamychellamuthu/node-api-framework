'use strict';

class Criteria {

    static EQUAL         = 'EQUAL';
    static NOT_EQUAL     = 'NOT_EQUAL';
    static LESS_THAN     = 'LESS_THAN';
    static LESS_EQUAL    = 'LESS_EQUAL';
    static GREATER_THAN  = 'GREATER_THAN';
    static GREATER_EQUAL = 'GREATER_EQUAL';
    static IN            = 'IN';
    static NOT_IN        = 'NOT_IN';
    static LIKE          = 'LIKE';
    static NOT_LIKE      = 'NOT_LIKE';
    static STARTS_WITH   = 'STARTS_WITH';
    static BETWEEN       = 'BETWEEN';
    static NOT_BETWEEN   = 'NOT_BETWEEN';
    static IS_NULL       = 'IS_NULL';
    static IS_NOT_NULL   = 'IS_NOT_NULL';

    constructor(kind, payload) {
        this._kind    = kind;
        this._payload = payload;
        Object.freeze(this._payload);
        Object.freeze(this);
    }

    static eq(column, value)          { return new Criteria('LEAF', { column, comparator: Criteria.EQUAL,         value }); }
    static neq(column, value)         { return new Criteria('LEAF', { column, comparator: Criteria.NOT_EQUAL,     value }); }
    static lt(column, value)          { return new Criteria('LEAF', { column, comparator: Criteria.LESS_THAN,     value }); }
    static lte(column, value)         { return new Criteria('LEAF', { column, comparator: Criteria.LESS_EQUAL,    value }); }
    static gt(column, value)          { return new Criteria('LEAF', { column, comparator: Criteria.GREATER_THAN,  value }); }
    static gte(column, value)         { return new Criteria('LEAF', { column, comparator: Criteria.GREATER_EQUAL, value }); }
    static in(column, value)          { return new Criteria('LEAF', { column, comparator: Criteria.IN,            value }); }
    static notIn(column, value)       { return new Criteria('LEAF', { column, comparator: Criteria.NOT_IN,        value }); }
    static like(column, value)        { return new Criteria('LEAF', { column, comparator: Criteria.LIKE,          value }); }
    static notLike(column, value)     { return new Criteria('LEAF', { column, comparator: Criteria.NOT_LIKE,      value }); }
    static startsWith(column, value)  { return new Criteria('LEAF', { column, comparator: Criteria.STARTS_WITH,   value }); }
    static between(column, lo, hi)    { return new Criteria('LEAF', { column, comparator: Criteria.BETWEEN,       value: [lo, hi] }); }
    static notBetween(column, lo, hi) { return new Criteria('LEAF', { column, comparator: Criteria.NOT_BETWEEN,   value: [lo, hi] }); }
    static isNull(column)             { return new Criteria('LEAF', { column, comparator: Criteria.IS_NULL,       value: null }); }
    static isNotNull(column)          { return new Criteria('LEAF', { column, comparator: Criteria.IS_NOT_NULL,   value: null }); }

    static leaf(column, comparator, value) {
        return new Criteria('LEAF', { column, comparator, value });
    }

    and(other) {
        if (!(other instanceof Criteria)) {
            throw new Error('[Criteria] and() requires a Criteria instance');
        }
        return new Criteria('COMPOSITE', { operator: 'AND', left: this, right: other });
    }

    or(other) {
        if (!(other instanceof Criteria)) {
            throw new Error('[Criteria] or() requires a Criteria instance');
        }
        return new Criteria('COMPOSITE', { operator: 'OR', left: this, right: other });
    }

    negate() {
        return new Criteria('NEGATED', { inner: this });
    }

    get kind()       { return this._kind; }
    get column()     { return this._payload.column; }
    get comparator() { return this._payload.comparator; }
    get value()      { return this._payload.value; }
    get operator()   { return this._payload.operator; }
    get left()       { return this._payload.left; }
    get right()      { return this._payload.right; }
    get inner()      { return this._payload.inner; }

    isLeaf()      { return this._kind === 'LEAF'; }
    isComposite() { return this._kind === 'COMPOSITE'; }
    isNegated()   { return this._kind === 'NEGATED'; }
}

module.exports = Criteria;
