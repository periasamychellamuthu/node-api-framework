'use strict';

const AbstractEntityHandler  = require('./AbstractEntityHandler');
const DefaultEntityValidator = require('../Validation/DefaultEntityValidator');
const dataAccess             = require('../Database/ORM/DataAccess');
const SequenceGenerator      = require('../Database/SequenceGenerator');
const JSONDOConverter        = require('../Transformer/JSONDOConverter');
const ResponseTransformer    = require('../Transformer/ResponseTransformer');
const ListenerDispatcher     = require('../Listener/ListenerDispatcher');
const { SelectQueryImpl, Criteria, Column, Table, Range, SortColumn } = require('../Database/QueryBuilder');

class PreDefaultEntityHandler extends AbstractEntityHandler {
    constructor() { super(); }

    _pkColumn(entity) {
        const idField = entity.getIdentifierField();
        return idField ? idField.getColumnName() : 'id';
    }

    /**
     * Derives explicit SELECT columns from the entity's field definitions.
     * Only fields that map to a real DB column in the entity's primary table
     * are included (collection fields are skipped).
     * Returns an array of Column instances to be added to a SelectQueryImpl.
     */
    _buildSelectColumns(entity) {
        const tableName = entity.getTableName();
        const columns   = [];
        for (const field of Object.values(entity.getFields())) {
            if (field.isCollection) continue;                     // no DB column
            if (!field.relationMapping) continue;                 // guard
            const fieldTable  = field.getTableName();
            const fieldColumn = field.getColumnName();
            // Only select columns that belong to this entity's primary table.
            // Joined-table fields (FK expansion) are resolved separately.
            if (fieldTable === tableName) {
                columns.push(Column.getColumn(tableName, fieldColumn));
            }
        }
        return columns;
    }

    async getList(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();
        const req       = request.context.request;
        const pkColumn  = this._pkColumn(entity);

        const sq = new SelectQueryImpl(Table.getTable(tableName));
        sq.addSelectColumns(this._buildSelectColumns(entity));
        if (req.rangeStart && req.rangeEnd) {
            sq.setCriteria(
                Criteria.between(Column.getColumn(tableName, pkColumn), req.rangeStart, req.rangeEnd)
            );
        }

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
        const req       = request.context.request;
        const pkColumn  = this._pkColumn(entity);

        if (!entityId) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'Entity ID is required for GET by ID' }
            });
        }

        const sq = new SelectQueryImpl(Table.getTable(tableName));
        sq.addSelectColumns(this._buildSelectColumns(entity));
        let criteria = Criteria.eq(Column.getColumn(tableName, pkColumn), entityId);
        if (req.rangeStart && req.rangeEnd) {
            criteria = criteria.and(
                Criteria.between(Column.getColumn(tableName, pkColumn), req.rangeStart, req.rangeEnd)
            );
        }
        sq.setCriteria(criteria);

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
        const pkColumn  = this._pkColumn(entity);

        await DefaultEntityValidator.validatePipeline(request);
        await ListenerDispatcher.dispatch('beforeCreate', entity, request.inputData, req);

        const plainObj = await JSONDOConverter.transformJSONToEntity(request);

        const orgId = req.orgId;
        if (!orgId) {
            return request.response.status(403).json({
                response_status: { status: 'failed', message: 'No active org context. This endpoint requires an org-scoped URL.' }
            });
        }

        const insertId     = await SequenceGenerator.getNextId(orgId);
        plainObj[pkColumn] = insertId;

        const dobj = dataAccess.constructDataObject();
        const row  = dataAccess.newRow(tableName);
        for (const [k, v] of Object.entries(plainObj)) row.set(k, v);
        dobj.addRow(row);
        await dataAccess.add(dobj);

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
        const pkColumn  = this._pkColumn(entity);

        await DefaultEntityValidator.validatePipeline(request);
        await ListenerDispatcher.dispatch('beforeUpdate', entity, request.inputData, req);

        const plainChanges = await JSONDOConverter.transformJSONToEntity(request);
        if (Object.keys(plainChanges).length === 0) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'No updatable fields provided' }
            });
        }

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
        const pkColumn  = this._pkColumn(entity);

        if (!entityId) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'Entity ID is required for DELETE' }
            });
        }

        await ListenerDispatcher.dispatch('beforeDelete', entity, { id: entityId }, req);

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
