const { QueryConstants, Criteria, Column } = require('./QueryPrimitives');

class DBUtils {
    /**
     * Serializes the programmatic Query object into a parameterized SQL Query array.
     */
    static getSelectQueryAsSQL(selectQuery) {
        let sql = 'SELECT ';
        
        if (selectQuery.selectColumns.length === 0) {
            sql += '* ';
        } else {
            sql += selectQuery.selectColumns.map(c => `${c.table.alias}.${c.columnName}`).join(', ') + ' ';
        }

        sql += `FROM ${selectQuery.baseTable.tableName} AS ${selectQuery.baseTable.alias} `;

        selectQuery.joins.forEach(join => {
            sql += `${join.joinType} ${join.joinTable.tableName} AS ${join.joinTable.alias} ON `;
            let onConditions = [];
            for (let i = 0; i < join.baseColumns.length; i++) {
                onConditions.push(`${join.baseTable.alias}.${join.baseColumns[i]} = ${join.joinTable.alias}.${join.joinColumns[i]}`);
            }
            sql += onConditions.join(' AND ') + ' ';
        });

        const params = [];
        if (selectQuery.criteria) {
            const { criteriaSql, criteriaParams } = this.resolveCriteria(selectQuery.criteria);
            sql += `WHERE ${criteriaSql} `;
            params.push(...criteriaParams);
        }

        if (selectQuery.sortColumns.length > 0) {
            sql += 'ORDER BY ' + selectQuery.sortColumns.map(s => `${s.column.table.alias}.${s.column.columnName} ${s.sortOrder}`).join(', ') + ' ';
        }

        if (selectQuery.range) {
            sql += `LIMIT ? OFFSET ?`;
            params.push(selectQuery.range.limit, selectQuery.range.offset);
        }

        return { sql: sql.trim(), params };
    }

    static resolveCriteria(criteria) {
        if (criteria.groupedCriteria && criteria.groupedCriteria.length > 0) {
            const left = this.resolveCriteria(criteria.groupedCriteria[0]);
            const right = this.resolveCriteria(criteria.groupedCriteria[1]);
            return {
                criteriaSql: `(${left.criteriaSql} ${criteria.logicalOperator} ${right.criteriaSql})`,
                criteriaParams: [...left.criteriaParams, ...right.criteriaParams]
            };
        }

        let conditionSql = '';
        if (criteria.condition === QueryConstants.IN || criteria.condition === QueryConstants.NOT_IN) {
            const placeholders = criteria.value.map(() => '?').join(', ');
            conditionSql = `${criteria.column.table.alias}.${criteria.column.columnName} ${criteria.condition} (${placeholders})`;
            return { criteriaSql: conditionSql, criteriaParams: [...criteria.value] };
        } else {
            conditionSql = `${criteria.column.table.alias}.${criteria.column.columnName} ${criteria.condition} ?`;
            return { criteriaSql: conditionSql, criteriaParams: [criteria.value] };
        }
    }

    /**
     * Applies the mandatory auto-tenant scoping rules.
     */
    static applyTenantScoping(selectQuery, tenantId) {
        const tenantCriteria = new Criteria(
            Column.getColumn(selectQuery.baseTable, 'tenant_id'), 
            tenantId, 
            QueryConstants.EQUAL
        );
        
        if (selectQuery.criteria) {
            selectQuery.criteria = selectQuery.criteria.and(tenantCriteria);
        } else {
            selectQuery.criteria = tenantCriteria;
        }
        console.log(`[DBUtils] Auto-Tenant Scoping applied for tenant: ${tenantId}`);
    }

    /**
     * Resolves metadata placeholders natively required by the framework.
     */
    static resolvePlaceholders(fieldValue, req) {
        if (typeof fieldValue !== 'string') return fieldValue;

        switch (fieldValue) {
            case '$now': return new Date().toISOString();
            case '$currentUser': return req.$currentUser;
            case '$currentTenant': return req.$currentTenant;
            default: return fieldValue;
        }
    }
}

module.exports = DBUtils;
