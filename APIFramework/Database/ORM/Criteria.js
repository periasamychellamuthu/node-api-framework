/**
 * Criteria — structured filter builder for the Versatile ORM layer.
 *
 * Design (row-oriented-orm-wrapper-over-knex.md §6):
 *   "Filters are expressed as structured criteria objects rather than raw Knex .where() calls.
 *    This keeps filter logic serializable, testable in isolation, and independent of the
 *    underlying query builder."
 *
 * Versatile additions beyond the reference doc:
 *   - `between` operator   → .whereBetween()   (used for org range scoping)
 *   - `notIn` operator     → .whereNotIn()
 *   - `notNull` operator   → .whereNotNull()
 *   - Fluent builder (CriteriaBuilder) as an ergonomic alternative to raw arrays
 *
 * Usage — raw array form (matches reference doc exactly):
 *   const criteria = [
 *     { column: 'status',    operator: 'eq',      value: 'active' },
 *     { column: 'member_id', operator: 'between', value: [1000001, 2000000] },
 *   ];
 *   await dataModel.get('org_members', criteria);
 *
 * Usage — fluent builder form:
 *   const criteria = new CriteriaBuilder()
 *       .eq('status', 'active')
 *       .between('member_id', rangeStart, rangeEnd)
 *       .build();
 *   await dataModel.get('org_members', criteria);
 */

// ─── Operator map ─────────────────────────────────────────────────────────────
// Each entry maps an operator name to a function that applies it to a Knex query.
// applyCriteria() iterates the criteria array and calls the matching function.

const OPERATOR_MAP = {
    /** Exact match — WHERE column = value */
    eq: (query, column, value) => query.where(column, value),

    /** Not equal — WHERE column != value */
    neq: (query, column, value) => query.whereNot(column, value),

    /** Greater than — WHERE column > value */
    gt: (query, column, value) => query.where(column, '>', value),

    /** Greater than or equal — WHERE column >= value */
    gte: (query, column, value) => query.where(column, '>=', value),

    /** Less than — WHERE column < value */
    lt: (query, column, value) => query.where(column, '<', value),

    /** Less than or equal — WHERE column <= value */
    lte: (query, column, value) => query.where(column, '<=', value),

    /** IN list — WHERE column IN (...values) */
    in: (query, column, value) => query.whereIn(column, value),

    /** NOT IN list — WHERE column NOT IN (...values) */
    notIn: (query, column, value) => query.whereNotIn(column, value),

    /** LIKE — WHERE column LIKE %value% */
    like: (query, column, value) => query.where(column, 'like', `%${value}%`),

    /** LIKE starts with — WHERE column LIKE value% */
    startsWith: (query, column, value) => query.where(column, 'like', `${value}%`),

    /** IS NULL — WHERE column IS NULL */
    isNull: (query, column) => query.whereNull(column),

    /** IS NOT NULL — WHERE column IS NOT NULL */
    notNull: (query, column) => query.whereNotNull(column),

    /**
     * BETWEEN — WHERE column BETWEEN value[0] AND value[1]
     * Core operator for org range scoping:
     *   { column: 'member_id', operator: 'between', value: [rangeStart, rangeEnd] }
     */
    between: (query, column, value) => query.whereBetween(column, value),

    /** NOT BETWEEN */
    notBetween: (query, column, value) => query.whereNotBetween(column, value),
};

// ─── applyCriteria ────────────────────────────────────────────────────────────

/**
 * Applies a criteria array to an existing Knex query builder instance.
 *
 * Each condition in the array:
 *   {
 *     column:   string,          — DB column name
 *     operator: string,          — one of OPERATOR_MAP keys
 *     value?:   any,             — comparison value (omit for isNull / notNull)
 *     join?:    'and' | 'or'     — defaults to 'and'
 *   }
 *
 * OR conditions are wrapped in a Knex sub-group so they don't pollute the AND chain:
 *   WHERE status = 'active' AND (role = 'OrgAdmin' OR role = 'SDAdmin')
 *
 * @param {object}  query    — Knex query builder instance
 * @param {Array}   criteria — array of condition objects
 * @returns {object}         — same Knex query builder (for chaining)
 */
function applyCriteria(query, criteria) {
    if (!criteria || criteria.length === 0) return query;

    for (const condition of criteria) {
        const apply = OPERATOR_MAP[condition.operator];
        if (!apply) {
            throw new Error(`[Criteria] Unsupported operator "${condition.operator}". ` +
                `Valid operators: ${Object.keys(OPERATOR_MAP).join(', ')}`);
        }

        if (condition.join === 'or') {
            query.orWhere(builder => apply(builder, condition.column, condition.value));
        } else {
            apply(query, condition.column, condition.value);
        }
    }

    return query;
}

// ─── CriteriaBuilder (fluent) ─────────────────────────────────────────────────

/**
 * Fluent builder that produces a criteria array compatible with applyCriteria().
 *
 * Example:
 *   const criteria = new CriteriaBuilder()
 *       .eq('status', 'active')
 *       .between('member_id', rangeStart, rangeEnd)
 *       .gt('created_at', someDate, 'and')
 *       .build();
 */
class CriteriaBuilder {
    constructor() {
        this._conditions = [];
    }

    _add(column, operator, value, join = 'and') {
        this._conditions.push({ column, operator, value, join });
        return this;
    }

    eq(column, value, join)         { return this._add(column, 'eq',         value, join); }
    neq(column, value, join)        { return this._add(column, 'neq',        value, join); }
    gt(column, value, join)         { return this._add(column, 'gt',         value, join); }
    gte(column, value, join)        { return this._add(column, 'gte',        value, join); }
    lt(column, value, join)         { return this._add(column, 'lt',         value, join); }
    lte(column, value, join)        { return this._add(column, 'lte',        value, join); }
    in(column, value, join)         { return this._add(column, 'in',         value, join); }
    notIn(column, value, join)      { return this._add(column, 'notIn',      value, join); }
    like(column, value, join)       { return this._add(column, 'like',       value, join); }
    startsWith(column, value, join) { return this._add(column, 'startsWith', value, join); }
    isNull(column, join)            { return this._add(column, 'isNull',     undefined, join); }
    notNull(column, join)           { return this._add(column, 'notNull',    undefined, join); }

    /**
     * Org range scoping shorthand.
     * Equivalent to: { column, operator: 'between', value: [start, end] }
     */
    between(column, start, end, join) {
        return this._add(column, 'between', [start, end], join);
    }

    notBetween(column, start, end, join) {
        return this._add(column, 'notBetween', [start, end], join);
    }

    /**
     * Returns the built criteria array.
     * @returns {Array<{ column, operator, value, join }>}
     */
    build() {
        return this._conditions;
    }
}

module.exports = { applyCriteria, CriteriaBuilder, OPERATOR_MAP };
