/**
 * DBUtils — Framework-level query utilities.
 *
 * After migration to Knex.js:
 *   - getSelectQueryAsSQL()  → retired (was: custom SelectQuery → SQL serializer)
 *   - resolveCriteria()      → retired (was: Criteria tree serializer)
 *   - applyRangeScoping()    → retired (was: injects BETWEEN on SelectQuery)
 *
 *   All of the above are now handled by Knex chains in PreDefaultEntityHandler:
 *     getList   → knex(table).whereBetween(pk, [rangeStart, rangeEnd])
 *     getEntity → knex(table).where(pk, id).whereBetween(pk, [start, end]).first()
 *     add       → knex(table).insert(data)
 *     edit      → knex(table).where(pk, id).update(data)
 *     delete    → knex(table).where(pk, id).delete()
 *
 * What remains:
 *   - resolvePlaceholders()  — still used by DefaultEntityValidator.fillDefaults stage
 *     to expand $now / $currentUser / $currentMember tokens in entity config default values.
 */
class DBUtils {

    /**
     * Resolves metadata placeholder strings used in entity config default values.
     *
     *   '$now'           → current ISO timestamp
     *   '$currentUser'   → req.authAccountId  (IAM identity — for framework-level audit fields)
     *   '$currentMember' → req.memberId       (product identity — for created_by, audit fields)
     *
     * Called by DefaultEntityValidator during the fillDefaults validation stage.
     *
     * @param {*}      fieldValue  — raw value from entity config (may or may not be a placeholder)
     * @param {object} req         — Express request object (set by OrgContextFilter / SecurityGatewayFilter)
     * @returns resolved value
     */
    static resolvePlaceholders(fieldValue, req) {
        if (typeof fieldValue !== 'string') return fieldValue;

        switch (fieldValue) {
            case '$now':           return new Date().toISOString();
            case '$currentUser':   return req.authAccountId;
            case '$currentMember': return req.memberId;
            default:               return fieldValue;
        }
    }
}

module.exports = DBUtils;
