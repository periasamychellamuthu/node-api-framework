const AbstractEntityHandler  = require('./AbstractEntityHandler');
const DefaultEntityValidator = require('../Validation/DefaultEntityValidator');
const DBUtils                = require('../Database/QueryBuilder/DBUtils');
const { SelectQuery, Criteria, Column, QueryConstants } = require('../Database/QueryBuilder/QueryModel');
const SQLConnect             = require('../Database/DBConnectionPool');
const SequenceGenerator      = require('../Database/SequenceGenerator');
const JSONDOConverter        = require('../Transformer/JSONDOConverter');
const ResponseTransformer    = require('../Transformer/ResponseTransformer');
const ListenerDispatcher     = require('../Listener/ListenerDispatcher');

/**
 * PreDefaultEntityHandler
 *
 * The core framework CRUD layer. Every domain handler (e.g. UserEntityHandler)
 * extends this class. Override any method for entity-specific behaviour;
 * call super.<method>(request) to retain the default pipeline.
 *
 * Pipeline per operation:
 *   add    : validate → beforeCreate listener → INSERT → fetch → afterCreate listener → respond
 *   edit   : validate → beforeUpdate listener → UPDATE → fetch → afterUpdate listener → respond
 *   getList: SELECT all rows (tenant-scoped when tenant_id column exists) → transform → respond
 *   getEntity: SELECT by id → transform → respond
 *   delete : validate id present → beforeDelete listener → DELETE → afterDelete listener → respond
 */
class PreDefaultEntityHandler extends AbstractEntityHandler {
    constructor() {
        super();
    }

    // ─── READ ────────────────────────────────────────────────────────────────

    async getList(request) {
        const entityConfig = request._entityConfig;
        const tableName    = request.entity.getTableName();

        const selectQuery = new SelectQuery(tableName);
        // tenant scoping will be applied here once tenant_id column is present on all tables

        const { sql, params } = DBUtils.getSelectQueryAsSQL(selectQuery);
        console.log(`[PreDefaultEntityHandler] getList SQL: ${sql}`, params);

        const rows = await SQLConnect.query(sql, params);

        // Transform each DB row → JSON shape using entity field relational_mapping
        const jsonRows = await Promise.all(rows.map(row => JSONDOConverter.transformEntityToJSON(row, request.entity)));

        const response = ResponseTransformer.transform(entityConfig, 'getList', jsonRows);
        return request.response.status(200).json(response);
    }

    async getEntity(request) {
        const entityConfig = request._entityConfig;
        const tableName    = request.entity.getTableName();
        const entityId     = request.entityId;

        if (!entityId) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'Entity ID is required for GET by ID' }
            });
        }

        const idField = request.entity.getIdentifierField();
        const idColumn = idField ? idField.getColumnName() : 'id';

        const selectQuery = new SelectQuery(tableName);
        const idCriteria  = new Criteria(
            Column.getColumn(tableName, idColumn),
            entityId,
            QueryConstants.EQUAL
        );
        selectQuery.setCriteria(idCriteria);

        const { sql, params } = DBUtils.getSelectQueryAsSQL(selectQuery);
        console.log(`[PreDefaultEntityHandler] getEntity SQL: ${sql}`, params);

        const rows = await SQLConnect.query(sql, params);

        if (!rows || rows.length === 0) {
            return request.response.status(404).json({
                response_status: { status: 'failed', message: `${entityConfig.entityName} not found` }
            });
        }

        const jsonRow  = await JSONDOConverter.transformEntityToJSON(rows[0], request.entity);
        const response = ResponseTransformer.transform(entityConfig, 'getEntity', jsonRow);
        return request.response.status(200).json(response);
    }

    // ─── WRITE ───────────────────────────────────────────────────────────────

    async add(request) {
        const entityConfig = request._entityConfig;
        const tableName    = request.entity.getTableName();

        // 1. Validate
        await DefaultEntityValidator.validatePipeline(request);

        // 2. Before-create listener
        await ListenerDispatcher.dispatch('beforeCreate', entityConfig, request.inputData, request.context.request);

        // 3. Build insert data: JSON field names → DB column names
        const dbObject = await JSONDOConverter.transformJSONToEntity(request);

        // 4. Generate tenant-partitioned PK
        // tenantId must be a real numeric ID — entity operations require an active tenant session.
        const tenantId = request.context.request.$credentials && request.context.request.$credentials.tenantId
            ? String(request.context.request.$credentials.tenantId)
            : null;

        if (!tenantId) {
            return request.response.status(403).json({
                response_status: {
                    status: 'failed',
                    message: 'No active tenant. Create or link a tenant before performing entity operations.'
                }
            });
        }

        const insertId = await SequenceGenerator.getNextId(tenantId, `${tableName}.id`);
        dbObject['id']  = insertId;

        // 5. INSERT
        const columns      = Object.keys(dbObject);
        const placeholders = columns.map(() => '?').join(', ');
        const values       = columns.map(c => dbObject[c]);
        const insertSQL    = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
        console.log(`[PreDefaultEntityHandler] add SQL: ${insertSQL}`, values);

        await SQLConnect.query(insertSQL, values);

        // 6. Fetch the created record to return it
        const idField  = request.entity.getIdentifierField();
        const idColumn = idField ? idField.getColumnName() : 'id';
        const rows     = await SQLConnect.query(
            `SELECT * FROM ${tableName} WHERE ${idColumn} = ?`, [insertId]
        );
        const jsonRow  = rows.length > 0 ? await JSONDOConverter.transformEntityToJSON(rows[0], request.entity) : dbObject;

        // 7. After-create listener
        await ListenerDispatcher.dispatch('afterCreate', entityConfig, jsonRow, request.context.request);

        const response = ResponseTransformer.transform(entityConfig, 'add', jsonRow);
        return request.response.status(200).json(response);
    }

    async edit(request) {
        const entityConfig = request._entityConfig;
        const tableName    = request.entity.getTableName();
        const entityId     = request.entityId;

        // 1. Validate (also checks entityId present for PUT)
        await DefaultEntityValidator.validatePipeline(request);

        // 2. Before-update listener
        await ListenerDispatcher.dispatch('beforeUpdate', entityConfig, request.inputData, request.context.request);

        // 3. Build update data: JSON field names → DB column names (skip identifier)
        const dbObject = await JSONDOConverter.transformJSONToEntity(request);

        if (Object.keys(dbObject).length === 0) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'No updatable fields provided' }
            });
        }

        // 4. UPDATE
        const idField  = request.entity.getIdentifierField();
        const idColumn = idField ? idField.getColumnName() : 'id';
        const setClause = Object.keys(dbObject).map(c => `${c} = ?`).join(', ');
        const values    = [...Object.values(dbObject), entityId];
        const updateSQL = `UPDATE ${tableName} SET ${setClause} WHERE ${idColumn} = ?`;
        console.log(`[PreDefaultEntityHandler] edit SQL: ${updateSQL}`, values);

        const result = await SQLConnect.query(updateSQL, values);

        if (result.affectedRows === 0) {
            return request.response.status(404).json({
                response_status: { status: 'failed', message: `${entityConfig.entityName} not found or nothing changed` }
            });
        }

        // 5. Fetch the updated record to return it
        const rows    = await SQLConnect.query(
            `SELECT * FROM ${tableName} WHERE ${idColumn} = ?`, [entityId]
        );
        const jsonRow = rows.length > 0 ? await JSONDOConverter.transformEntityToJSON(rows[0], request.entity) : {};

        // 6. After-update listener
        await ListenerDispatcher.dispatch('afterUpdate', entityConfig, jsonRow, request.context.request);

        const response = ResponseTransformer.transform(entityConfig, 'edit', jsonRow);
        return request.response.status(200).json(response);
    }

    async delete(request) {
        const entityConfig = request._entityConfig;
        const tableName    = request.entity.getTableName();
        const entityId     = request.entityId;

        if (!entityId) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'Entity ID is required for DELETE' }
            });
        }

        // 1. Before-delete listener
        await ListenerDispatcher.dispatch('beforeDelete', entityConfig, { id: entityId }, request.context.request);

        // 2. DELETE
        const idField  = request.entity.getIdentifierField();
        const idColumn = idField ? idField.getColumnName() : 'id';
        const deleteSQL = `DELETE FROM ${tableName} WHERE ${idColumn} = ?`;
        console.log(`[PreDefaultEntityHandler] delete SQL: ${deleteSQL}`, [entityId]);

        const result = await SQLConnect.query(deleteSQL, [entityId]);

        if (result.affectedRows === 0) {
            return request.response.status(404).json({
                response_status: { status: 'failed', message: `${entityConfig.entityName} not found` }
            });
        }

        // 3. After-delete listener
        await ListenerDispatcher.dispatch('afterDelete', entityConfig, { id: entityId }, request.context.request);

        return request.response.status(200).json({
            response_status: { status: 'success', message: `${entityConfig.entityName} deleted successfully` }
        });
    }

    // ─── CUSTOM OPERATIONS (override in domain handler) ──────────────────────

    async handleOperation(request) {
        throw new Error(`handleOperation not implemented for ${request.entity.getName()}. Override in your domain handler.`);
    }

    async getAllowedValues(request) {
        throw new Error(`getAllowedValues not implemented for ${request.entity.getName()}. Override in your domain handler.`);
    }
}

module.exports = PreDefaultEntityHandler;
