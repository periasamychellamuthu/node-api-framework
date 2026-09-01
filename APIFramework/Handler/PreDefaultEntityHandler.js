'use strict';

const AbstractEntityHandler  = require('./AbstractEntityHandler');
const DefaultEntityValidator = require('../Validation/DefaultEntityValidator');
const dataAccess             = require('../Database/ORM/DataAccess');
const JSONDOConverter        = require('../Transformer/JSONDOConverter');
const ResponseTransformer    = require('../Transformer/ResponseTransformer');
const ListenerDispatcher     = require('../Listener/ListenerDispatcher');
const RequestContext          = require('../Context/RequestContext');
const { SelectQueryImpl, Criteria, Column, Table, Range, SortColumn } = require('../Database/QueryBuilder');

class PreDefaultEntityHandler extends AbstractEntityHandler {
    constructor() { super(); }

    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Derives explicit SELECT columns from the entity's field definitions.
     * Only fields that map to a real DB column in the entity's primary table
     * are included (collection fields are skipped).
     */
    _buildSelectColumns(entity) {
        const tableName = entity.getTableName();
        const columns   = [];
        for (const field of Object.values(entity.getFields())) {
            if (field.isCollection) continue;
            if (!field.relationMapping) continue;
            const fieldTable  = field.getTableName();
            const fieldColumn = field.getColumnName();
            if (fieldTable === tableName) {
                columns.push(Column.getColumn(tableName, fieldColumn));
            }
        }
        return columns;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CRUD operations
    //
    // Range scoping is handled automatically by DataAccess.get() / getOne().
    // RequestContext (ALS) carries rangeStart/rangeEnd for the current request.
    // No manual Criteria.between() calls are needed here.
    //
    // PK generation is handled automatically by Row.get(pkColumn):
    //   - For org-scoped PKs (<uniquevalue-generation> declared in DD XML),
    //     Row.get() calls SequenceGenerator.getNextIdSync(orgId) and returns
    //     a real ID immediately.
    //   - No manual SequenceGenerator.getNextId() calls in handlers.
    // ─────────────────────────────────────────────────────────────────────────

    async getList(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();

        // Build query — no range criteria needed, DataAccess.get() injects it
        const sq = new SelectQueryImpl(Table.getTable(tableName));
        sq.addSelectColumns(this._buildSelectColumns(entity));

        const rows     = await dataAccess.get(sq);
        const jsonRows = await Promise.all(
            rows.map(row => JSONDOConverter.transformEntityToJSON(row.toObject(), entity))
        );

        return request.response.status(200).json(
            ResponseTransformer.transform(entity, 'getList', jsonRows)
        );
    }

    async getEntity(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();
        const entityId  = request.entityId;
        const pkColumn  = entity.getIdentifierField().getColumnName();

        if (!entityId) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'Entity ID is required for GET by ID' }
            });
        }

        // Set the specific ID criteria — DataAccess.getOne() will AND the range on top
        const sq = new SelectQueryImpl(Table.getTable(tableName));
        sq.addSelectColumns(this._buildSelectColumns(entity));
        sq.setCriteria(Criteria.eq(Column.getColumn(tableName, pkColumn), entityId));

        const row = await dataAccess.getOne(sq);

        if (!row) {
            return request.response.status(404).json({
                response_status: { status: 'failed', message: `${entity.getName()} not found` }
            });
        }

        const jsonRow = await JSONDOConverter.transformEntityToJSON(row.toObject(), entity);
        return request.response.status(200).json(
            ResponseTransformer.transform(entity, 'getEntity', jsonRow)
        );
    }

    async add(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();
        const req       = request.context.request;
        const pkColumn  = entity.getIdentifierField().getColumnName();

        await DefaultEntityValidator.validatePipeline(request);
        await ListenerDispatcher.dispatch('beforeCreate', entity, request.inputData, req);

        const plainObj = await JSONDOConverter.transformJSONToEntity(request);

        const dobj = dataAccess.constructDataObject();
        const row  = dataAccess.newRow(tableName);
        for (const [k, v] of Object.entries(plainObj)) row.set(k, v);
        dobj.addRow(row);

        // PK is auto-generated by Row.get(pkColumn) the first time it is read.
        // Trigger it now so we have the real ID for the post-INSERT fetch.
        // Row.get() calls SequenceGenerator.getNextIdSync(orgId) via RequestContext.
        const insertId = row.get(pkColumn);

        await dataAccess.add(dobj);

        // Fetch back by exact PK — DataAccess.getOne() will AND the range automatically
        const fetchSq = new SelectQueryImpl(Table.getTable(tableName));
        fetchSq.addSelectColumns(this._buildSelectColumns(entity));
        fetchSq.setCriteria(Criteria.eq(Column.getColumn(tableName, pkColumn), insertId));
        const created = await dataAccess.getOne(fetchSq);
        const jsonRow = await JSONDOConverter.transformEntityToJSON(
            created ? created.toObject() : plainObj, entity
        );

        await ListenerDispatcher.dispatch('afterCreate', entity, jsonRow, req);

        return request.response.status(200).json(
            ResponseTransformer.transform(entity, 'add', jsonRow)
        );
    }

    async edit(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();
        const entityId  = request.entityId;
        const req       = request.context.request;
        const pkColumn  = entity.getIdentifierField().getColumnName();

        await DefaultEntityValidator.validatePipeline(request);
        await ListenerDispatcher.dispatch('beforeUpdate', entity, request.inputData, req);

        const plainChanges = await JSONDOConverter.transformJSONToEntity(request);
        if (Object.keys(plainChanges).length === 0) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'No updatable fields provided' }
            });
        }

        // Fetch existing — DataAccess.getOne() auto-scopes by range, so a user
        // from a different org that guesses this ID will get null → 404
        const fetchSq = new SelectQueryImpl(Table.getTable(tableName));
        fetchSq.addSelectColumns(this._buildSelectColumns(entity));
        fetchSq.setCriteria(Criteria.eq(Column.getColumn(tableName, pkColumn), entityId));
        const existing = await dataAccess.getOne(fetchSq);

        if (!existing) {
            return request.response.status(404).json({
                response_status: { status: 'failed', message: `${entity.getName()} not found` }
            });
        }

        for (const [k, v] of Object.entries(plainChanges)) existing.set(k, v);

        if (!existing.isDirty()) {
            return request.response.status(200).json(
                ResponseTransformer.transform(entity, 'edit', await JSONDOConverter.transformEntityToJSON(existing.toObject(), entity))
            );
        }

        const dobj = dataAccess.constructDataObject();
        dobj.updateRow(existing);
        await dataAccess.update(dobj);

        // Fetch updated row — range auto-scoped again
        const updatedSq = new SelectQueryImpl(Table.getTable(tableName));
        updatedSq.addSelectColumns(this._buildSelectColumns(entity));
        updatedSq.setCriteria(Criteria.eq(Column.getColumn(tableName, pkColumn), entityId));
        const updated = await dataAccess.getOne(updatedSq);
        const jsonRow = await JSONDOConverter.transformEntityToJSON(
            updated ? updated.toObject() : existing.toObject(), entity
        );

        await ListenerDispatcher.dispatch('afterUpdate', entity, jsonRow, req);

        return request.response.status(200).json(
            ResponseTransformer.transform(entity, 'edit', jsonRow)
        );
    }

    async delete(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();
        const entityId  = request.entityId;
        const req       = request.context.request;
        const pkColumn  = entity.getIdentifierField().getColumnName();

        if (!entityId) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'Entity ID is required for DELETE' }
            });
        }

        await ListenerDispatcher.dispatch('beforeDelete', entity, { id: entityId }, req);

        // Fetch existing — range auto-scoped, cross-org delete attempt returns null → 404
        const fetchSq = new SelectQueryImpl(Table.getTable(tableName));
        fetchSq.addSelectColumns(this._buildSelectColumns(entity));
        fetchSq.setCriteria(Criteria.eq(Column.getColumn(tableName, pkColumn), entityId));
        const existing = await dataAccess.getOne(fetchSq);

        if (!existing) {
            return request.response.status(404).json({
                response_status: { status: 'failed', message: `${entity.getName()} not found` }
            });
        }

        const dobj = dataAccess.constructDataObject();
        dobj.deleteRow(existing);
        await dataAccess.delete(dobj);

        await ListenerDispatcher.dispatch('afterDelete', entity, { id: entityId }, req);

        return request.response.status(200).json({
            response_status: { status: 'success', message: `${entity.getName()} deleted successfully` }
        });
    }

    async handleOperation(request) {
        throw new Error(`handleOperation not implemented for ${request.entity.getName()}. Override in your domain handler.`);
    }

    async getAllowedValues(request) {
        throw new Error(`getAllowedValues not implemented for ${request.entity.getName()}. Override in your domain handler.`);
    }
}

module.exports = PreDefaultEntityHandler;
