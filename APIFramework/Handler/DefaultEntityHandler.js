const PreDefaultEntityHandler = require('./PreDefaultEntityHandler');
const DefaultEntityValidator  = require('../Validation/DefaultEntityValidator');
const ListenerDispatcher      = require('../Listener/ListenerDispatcher');
const SequenceGenerator       = require('../Database/SequenceGenerator');
const SQLConnect              = require('../Database/DBConnectionPool');
const DBUtils                 = require('../Database/QueryBuilder/DBUtils');
const { SelectQuery, Criteria, Column, QueryConstants } = require('../Database/QueryBuilder/QueryModel');
const JSONDOConverter         = require('../Transformer/JSONDOConverter');
const ResponseTransformer     = require('../Transformer/ResponseTransformer');
const Entity                  = require('../API/Entity');

/**
 * DefaultEntityHandler
 *
 * The framework's default entity handler — used by ALL entity configs that do NOT
 * specify a custom domain handler (i.e. "handler": "DefaultEntityHandler" in entity JSON).
 *
 * Extends PreDefaultEntityHandler which owns all CRUD implementations
 * (add / edit / delete / getList / getEntity). This class inherits all of them.
 *
 * Previously this was defaultEntityHandler.js (git: 9ff288c) — a function-constructor
 * style class backed by node-querybuilder (SQLConnect.runBuilder + queryGeneratorAndExecutor).
 * That approach has been superseded by the new DBConnectionPool + SelectQuery + DBUtils APIs.
 *
 * What was in the old implementation              → What it maps to now
 * ─────────────────────────────────────────────────────────────────────────────
 * SQLConnect.runBuilder(cb)                       → SQLConnect.query() / SQLConnect.withConnection()
 * queryBuilder.queryGet(qb, apiReq, cb)           → SelectQuery + DBUtils.getSelectQueryAsSQL + SQLConnect.query
 * queryBuilder.queryInsert(qb, {table,data})      → INSERT INTO raw SQL via SQLConnect.query
 * queryBuilder.queryUpdate(qb, {table,data,crit}) → UPDATE raw SQL via SQLConnect.query
 * queryBuilder.queryDelete(qb, {table})           → DELETE raw SQL via SQLConnect.query
 * queryBuilder._applyTenantBounds(qb, req)        → DBUtils.applyRangeScoping(selectQuery, rangeStart, rangeEnd, pkCol)
 * SequenceGenerator.getNextId(tenantId, genName)  → SequenceGenerator.getNextId(orgId)   [one arg, numeric]
 * $credentials.tenantId                           → req.orgId  (set by OrgContextFilter)
 *
 * All add/edit/delete/getList/getEntity logic lives in PreDefaultEntityHandler.
 * This class retains the internal helper methods from the old implementation
 * (convertTOJSON, getInputValuesFromInputData, executeResult, etc.) which are
 * still useful for domain handlers that extend this class.
 *
 * Architecture reference: architecture-knowledge-base.md §1, §5, §12
 * Git reference: 9ff288c (old defaultEntityHandler.js implementation pattern)
 */
class DefaultEntityHandler extends PreDefaultEntityHandler {

    constructor() {
        super();
        this.APIRequest = null;
        this.entity     = null;
    }

    // ─── Legacy helper methods (retained from old defaultEntityHandler.js) ────
    //
    // These helpers are kept for backward compat with domain handlers that call
    // them directly, and for use inside the class itself.
    // They do NOT call any DB APIs — they are pure data-mapping utilities.

    /**
     * Maps DB rows back to JSON shape using the entity field relational_mapping.
     * Equivalent of iterateFieldsAndGetResult from the old implementation.
     *
     * Sets APIRequest.result directly (same pattern as old getCallback / getListCallback).
     */
    convertTOJSON(apiRequest) {
        if (apiRequest.dataObject instanceof Array) {
            apiRequest.result = [];
            for (let i = 0; i < apiRequest.dataObject.length; i++) {
                apiRequest.result.push(
                    this._iterateFieldsAndGetResult(apiRequest.entity, {}, apiRequest, apiRequest.dataObject[i])
                );
            }
        } else {
            apiRequest.result = this._iterateFieldsAndGetResult(apiRequest.entity, {}, apiRequest);
        }
    }

    /**
     * Extracts and maps form field values from inputData → DB column names.
     * Skips identifier fields (auto-generated).
     * Input shape: { "member": { "auth_account_id": 456, "status": "active" } }
     */
    getInputValuesFromInputData() {
        const rawFormData  = this.APIRequest.inputData.getEntityData() || {};
        const entityName   = this.APIRequest.entity.getName();
        const formData     = rawFormData[entityName] || {};

        const keyValue = {};
        const fields   = this.APIRequest.entity.getFields();
        Object.keys(fields).forEach(field => {
            if (fields[field].isIdentifier) return;
            const val = formData[fields[field].name];
            if (val !== undefined && val !== null) {
                keyValue[this._getColumnName(fields[field].relationMapping)] = val;
            }
        });
        return keyValue;
    }

    /**
     * Wraps result in the standard response envelope.
     * { response_status: {...}, [pluralName]: result }
     * Same as old executeResult.
     */
    executeResult(apiRequest, err) {
        const result = apiRequest.result;
        if (!err) {
            apiRequest.result = {
                response_status: { status: 200, message: 'Operation successful' },
                [apiRequest.entity.getPluralName()]: result
            };
        } else {
            apiRequest.result = {
                response_status: { status: 500, message: 'Operation failed' },
                error: err
            };
        }
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    /**
     * Extracts column name from relational_mapping string ("table.column" → "column").
     */
    _getColumnName(relationMapping) {
        if (!relationMapping) return null;
        return relationMapping.split('.')[1];
    }

    /**
     * Recursively walks entity fields and maps DB column values back to JSON field names.
     * Handles reference entity expansion (refEntity fields).
     * Equivalent of old iterateFieldsAndGetResult module-level function.
     */
    _iterateFieldsAndGetResult(entity, entityResult, apiRequest, dataObject) {
        const fields = entity.getFields();
        Object.keys(fields).forEach(field => {
            if (fields[field].refEntity) {
                entityResult[fields[field].refEntity] = this._iterateFieldsAndGetResult(
                    Entity.getEntityByName(fields[field].refEntity),
                    {},
                    apiRequest,
                    dataObject
                );
            } else {
                entityResult[fields[field].name] = this._getValueFromRelationMapping(
                    dataObject || apiRequest.dataObject,
                    fields[field].relationMapping
                );
            }
        });
        return entityResult;
    }

    /**
     * Reads a value from a DB row using relational_mapping ("table.column").
     * DB rows from nestTables queries come back as { table: { column: value } }.
     * Plain query results come back as flat { column: value }.
     * We handle both shapes.
     */
    _getValueFromRelationMapping(dataObject, mapping) {
        if (!mapping || !dataObject) return undefined;
        const parts = mapping.split('.');
        // Nested shape: dataObject[table][column]
        if (parts.length === 2 && dataObject[parts[0]] !== undefined) {
            return dataObject[parts[0]][parts[1]];
        }
        // Flat shape: dataObject[column]
        if (parts.length === 2) {
            return dataObject[parts[1]];
        }
        return dataObject[mapping];
    }
}

module.exports = DefaultEntityHandler;
