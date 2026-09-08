'use strict';

/**
 * PreDefaultEntityHandler — the core CRUD engine for all entities.
 *
 * Extends AbstractEntityHandler. Every entity's handler ultimately inherits from this class
 * (directly or via DefaultEntityHandler). It owns the full lifecycle for all five operations:
 *   getList, getEntity, add, edit, delete
 *
 * ── Sub-entity support ────────────────────────────────────────────────────────
 * When request.navigationInfo is present (URL like /requests/123/worklogs):
 *
 *   getList()  → applyScopingRules() adds WHERE child_fk_col = parentId
 *   add()      → _injectParentFK() sets the FK column in the row before INSERT
 *   delete()   → _cascadeDeleteSubEntities() issues raw DELETE WHERE for cascade fields
 *
 * Domain handlers override applyScopingRules() for multi-parent or custom scoping:
 *   class NoteHandler extends PreDefaultEntityHandler {
 *       applyScopingRules(sq, navInfo, entity) {
 *           if (navInfo.getParentEntity().getName() === 'request') {
 *               sq.setCriteria(Criteria.eq(Column.getColumn('notes', 'request_id'), navInfo.getParentEntityId()));
 *           }
 *       }
 *   }
 *
 * ── Ref entity support ────────────────────────────────────────────────────────
 * Handled entirely in JSONDOConverter and DefaultEntityValidator:
 *   - Input:  {"status": {"id": 301}} → STATUSID = 301  (converter unwraps)
 *   - Output: STATUSID = 301 → {"status": {"id": 301, "name": "Open"}}  (converter expands)
 *   - Validation: checkRefIDs() verifies the ID exists in the ref entity's table
 *
 * ── Transaction lifecycle ─────────────────────────────────────────────────────
 * Phase 1 (inside txn): beforeXxx listener + DB write + post-write fetch
 * Phase 2 (after commit): afterXxx listener — DB is durable at this point
 * Cascade deletes run INSIDE the parent transaction (same trx handle).
 *
 * ── PK generation ─────────────────────────────────────────────────────────────
 * Row.get(pkColumn) eagerly calls SequenceGenerator.getNextIdSync(orgId) for columns
 * with <uniquevalue-generation> in the data dictionary. No manual PK assignment needed.
 */

const AbstractEntityHandler  = require('./AbstractEntityHandler');
const DefaultEntityValidator = require('../Validation/DefaultEntityValidator');
const dataAccess             = require('../Database/ORM/DataAccess');
const JSONDOConverter        = require('../Transformer/JSONDOConverter');
const ResponseTransformer    = require('../Transformer/ResponseTransformer');
const ListenerDispatcher     = require('../Listener/ListenerDispatcher');
const RequestContext          = require('../Context/RequestContext');
const TransactionManager     = require('../Transaction/TransactionManager');
const { SelectQueryImpl, Criteria, Column, Table } = require('../Database/QueryBuilder');
const { CriteriaBuilder }    = require('../Database/ORM/Criteria');

class PreDefaultEntityHandler extends AbstractEntityHandler {

    constructor() { super(); }

    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Derives explicit SELECT columns from the entity's field definitions.
     * Only scalar fields that map to a real DB column in the entity's primary table
     * are included. Sub-entity collection fields and internal fields are skipped.
     */
    _buildSelectColumns(entity) {
        const tableName = entity.getTableName();
        const columns   = [];
        for (const field of Object.values(entity.getFields())) {
            if (field.standaloneCRUD || field.isCollection) continue;
            if (!field.relationMapping) continue;
            const fieldTable = field.getTableName ? field.getTableName() : field.relationMapping.split('.')[0];
            if (fieldTable === tableName) {
                const col = field.getColumnName ? field.getColumnName() : field.relationMapping.split('.')[1];
                columns.push(Column.getColumn(tableName, col));
            }
        }
        return columns;
    }

    /**
     * Finds the child entity field that holds the parent FK.
     *
     * The child entity declares a field like:
     *   { "name": "request_id", "relational_mapping": "notes.request_id",
     *     "entity": "request", "internal": true }
     *
     * This method scans the child entity's fields for a field where:
     *   field.refEntity === parentEntityName   (matches parent)
     *   field.isInternal === true              (FK field, not API-exposed)
     *
     * @param {Entity}      childEntity
     * @param {string}      parentEntityName
     * @returns {EntityField|null}
     */
    _findParentFKField(childEntity, parentEntityName) {
        for (const field of Object.values(childEntity.getFields())) {
            if (field.refEntity === parentEntityName && field.isInternal) {
                return field;
            }
        }
        return null;
    }

    /**
     * Injects the parent FK value into the plain column-keyed object before Row construction.
     *
     * Called in add() after JSONDOConverter.transformJSONToEntity().
     * The validator's fillRefs() has already placed {"id": parentId} in entityData,
     * so by the time this runs, the converter has already written the FK column.
     * This method is an explicit safety net — it directly sets the column if missing.
     *
     * @param {Object}         plainObj    — column-keyed object from transformJSONToEntity()
     * @param {Entity}         entity      — the child entity
     * @param {NavigationInfo} navInfo     — parent context
     */
    _injectParentFK(plainObj, entity, navInfo) {
        if (!navInfo) return;

        const parentEntityName = navInfo.getParentEntity()
            ? navInfo.getParentEntity().getName()
            : null;
        const parentId = navInfo.getParentEntityId();

        if (!parentEntityName || parentId == null) return;

        const fkField = this._findParentFKField(entity, parentEntityName);
        if (!fkField) {
            console.warn(
                `[Handler] _injectParentFK: no internal FK field found on '${entity.getName()}' ` +
                `pointing to '${parentEntityName}' — parent FK will not be set`
            );
            return;
        }

        const fkColName = fkField.getColumnName ? fkField.getColumnName() : fkField.relationMapping.split('.')[1];

        // Only inject if the converter hasn't already written it
        if (plainObj[fkColName] == null) {
            plainObj[fkColName] = parentId;
            console.log(
                `[Handler] _injectParentFK: set ${fkColName} = ${parentId} (${parentEntityName}→${entity.getName()})`
            );
        }
    }

    /**
     * Issues raw DELETE WHERE for all sub-entity collection fields declared with
     * "delete": "cascade" on the parent entity.
     *
     * This is Path B (raw DELETE) as defined in DOC-01 §13 and internal-api doc §2B:
     *   - No sub-entity handler invoked
     *   - No listeners fired on sub-entity
     *   - One parameterised DELETE FROM <childTable> WHERE <fkCol> = <parentId> per field
     *
     * Runs INSIDE the parent's open transaction so everything rolls back together.
     *
     * The parent field's relational_mapping = "ChildTable.FKColumn" gives us:
     *   - childTable: the table to delete from
     *   - fkCol:      the column that stores the parent ID on the child
     *
     * @param {number} parentId   — the parent record's PK
     * @param {Entity} entity     — the parent entity (whose fields declare cascade)
     * @param {object} trx        — active Knex transaction
     */
    async _cascadeDeleteSubEntities(parentId, entity, trx) {
        for (const field of Object.values(entity.getFields())) {
            if (!field.isCollection || field.deleteMode !== 'cascade') continue;
            if (!field.relationMapping) continue;

            // Parent's collection field relational_mapping = "ChildTable.FKColumn"
            const [childTable, fkCol] = field.relationMapping.split('.');

            if (!childTable || !fkCol) {
                console.warn(
                    `[Handler] _cascadeDeleteSubEntities: cannot parse relational_mapping ` +
                    `'${field.relationMapping}' on field '${field.name}' — skipping cascade`
                );
                continue;
            }

            const criteria = new CriteriaBuilder().eq(fkCol, parentId).build();
            const dobj     = dataAccess.constructDataObject();
            dobj.deleteRows(childTable, criteria);
            await dataAccess.delete(dobj, trx);

            console.log(
                `[Handler] _cascadeDeleteSubEntities: deleted rows from '${childTable}' ` +
                `WHERE ${fkCol} = ${parentId} (cascade from '${entity.getName()}')`
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Override points for domain handlers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Applies parent-scoping WHERE criteria to a SelectQuery for sub-entity GET LIST.
     *
     * Default behaviour:
     *   When navInfo is present, finds the child entity's internal FK field
     *   (entity=parentEntityName, internal=true) and adds:
     *     WHERE <childTable>.<fkColumn> = navInfo.getParentEntityId()
     *
     * Domain handlers override this for:
     *   - Multi-parent sub-entities (note under request OR problem)
     *   - Custom scoping beyond parent FK (e.g. only active sub-records)
     *   - Additional row-level security criteria
     *
     * @param {SelectQueryImpl} sq      — query to scope (mutate in place)
     * @param {NavigationInfo}  navInfo — parent context (null for top-level requests)
     * @param {Entity}          entity  — the child entity being queried
     */
    applyScopingRules(sq, navInfo, entity) {
        if (!navInfo) return;

        const parentEntityName = navInfo.getParentEntity()
            ? navInfo.getParentEntity().getName()
            : null;
        const parentId = navInfo.getParentEntityId();

        if (!parentEntityName || parentId == null) return;

        const fkField = this._findParentFKField(entity, parentEntityName);
        if (!fkField) {
            console.warn(
                `[Handler] applyScopingRules: no internal FK field found on '${entity.getName()}' ` +
                `pointing to '${parentEntityName}' — list will not be scoped to parent`
            );
            return;
        }

        const childTable = fkField.getTableName ? fkField.getTableName() : fkField.relationMapping.split('.')[0];
        const fkCol      = fkField.getColumnName ? fkField.getColumnName() : fkField.relationMapping.split('.')[1];

        sq.setCriteria(Criteria.eq(Column.getColumn(childTable, fkCol), parentId));

        console.log(
            `[Handler] applyScopingRules: scoped '${entity.getName()}' list to ` +
            `${childTable}.${fkCol} = ${parentId} (parent: ${parentEntityName})`
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CRUD operations
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * GET LIST — returns all records for an entity, scoped to the parent if navInfo present.
     *
     * DataAccess.get() auto-injects tenant/range scoping.
     * applyScopingRules() adds the parent FK WHERE for sub-entity list requests.
     */
    async getList(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();

        const sq = new SelectQueryImpl(Table.getTable(tableName));
        sq.addSelectColumns(this._buildSelectColumns(entity));

        // Apply parent FK scoping when this is a sub-entity list (e.g. GET /requests/123/notes)
        this.applyScopingRules(sq, request.navigationInfo, entity);

        const rows     = await dataAccess.get(sq);
        const jsonRows = await Promise.all(
            rows.map(row => JSONDOConverter.transformEntityToJSON(row.toObject(), entity))
        );

        return request.response.status(200).json(
            ResponseTransformer.transform(entity, 'getList', jsonRows)
        );
    }

    /**
     * GET SINGLE — returns one record by PK.
     *
     * No parent scoping needed here — the PK is globally unique within tenant range.
     */
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

    /**
     * ADD (POST) — creates a new record.
     *
     * Sub-entity flow:
     *   1. Validator fillRefs() injects {"id": parentId} into input data for the FK field
     *   2. Converter unwraps it to the FK column value
     *   3. _injectParentFK() is a safety net — sets the FK column directly if still missing
     *
     * Transaction lifecycle:
     *   Phase 1 (inside txn): beforeCreate + DB INSERT + fetch-back
     *   Phase 2 (after commit): afterCreate
     */
    async add(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();
        const req       = request.context.request;
        const pkColumn  = entity.getIdentifierField().getColumnName();

        await DefaultEntityValidator.validatePipeline(request);

        const plainObj = await JSONDOConverter.transformJSONToEntity(request);

        // Safety net: ensure parent FK is set even if converter missed it
        this._injectParentFK(plainObj, entity, request.navigationInfo);

        const dobj = dataAccess.constructDataObject();
        const row  = dataAccess.newRow(tableName);
        for (const [k, v] of Object.entries(plainObj)) row.set(k, v);
        dobj.addRow(row);

        // Trigger PK generation eagerly so we have the real ID for the post-INSERT fetch
        const insertId = row.get(pkColumn);

        // ── Transaction lifecycle ─────────────────────────────────────────────
        const handle = await TransactionManager.beginTxn();
        let jsonRow;
        try {
            await ListenerDispatcher.dispatch('beforeCreate', entity, request.inputData, req);

            await dataAccess.add(dobj, handle.trx);

            // Fetch back inside the same transaction to read our own write
            const fetchSq = new SelectQueryImpl(Table.getTable(tableName));
            fetchSq.addSelectColumns(this._buildSelectColumns(entity));
            fetchSq.setCriteria(Criteria.eq(Column.getColumn(tableName, pkColumn), insertId));
            const created = await dataAccess.getOne(fetchSq, handle.trx);
            jsonRow = await JSONDOConverter.transformEntityToJSON(
                created ? created.toObject() : plainObj, entity
            );

            await TransactionManager.commitTxn(handle);
        } catch (err) {
            await TransactionManager.rollbackTxn(handle);
            return request.response.status(500).json({
                response_status: { status: 'failed', message: err.message }
            });
        }

        // Phase 2 — afterCreate fires AFTER commit; DB write is durable
        await ListenerDispatcher.dispatch('afterCreate', entity, jsonRow, req);

        return request.response.status(200).json(
            ResponseTransformer.transform(entity, 'add', jsonRow)
        );
    }

    /**
     * EDIT (PUT) — updates an existing record (partial update — only dirty columns written).
     *
     * Existence fetch is a pre-transaction read (no txn needed for reads).
     * Internal FK fields are never overwritten by client input on PUT
     * (enforced in JSONDOConverter.transformJSONToEntity — skips internal fields on PUT).
     *
     * Transaction lifecycle:
     *   Phase 1 (inside txn): beforeUpdate + DB UPDATE + fetch-back
     *   Phase 2 (after commit): afterUpdate
     */
    async edit(request) {
        const entity    = request.entity;
        const tableName = entity.getTableName();
        const entityId  = request.entityId;
        const req       = request.context.request;
        const pkColumn  = entity.getIdentifierField().getColumnName();

        await DefaultEntityValidator.validatePipeline(request);

        const plainChanges = await JSONDOConverter.transformJSONToEntity(request);
        if (Object.keys(plainChanges).length === 0) {
            return request.response.status(400).json({
                response_status: { status: 'failed', message: 'No updatable fields provided' }
            });
        }

        // Fetch existing before the transaction — read-only, no txn needed
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

        // Nothing changed — return current state without touching the DB
        if (!existing.isDirty()) {
            return request.response.status(200).json(
                ResponseTransformer.transform(entity, 'edit',
                    await JSONDOConverter.transformEntityToJSON(existing.toObject(), entity))
            );
        }

        // ── Transaction lifecycle ─────────────────────────────────────────────
        const handle = await TransactionManager.beginTxn();
        let jsonRow;
        try {
            await ListenerDispatcher.dispatch('beforeUpdate', entity, request.inputData, req);

            const dobj = dataAccess.constructDataObject();
            dobj.updateRow(existing);
            await dataAccess.update(dobj, handle.trx);

            const updatedSq = new SelectQueryImpl(Table.getTable(tableName));
            updatedSq.addSelectColumns(this._buildSelectColumns(entity));
            updatedSq.setCriteria(Criteria.eq(Column.getColumn(tableName, pkColumn), entityId));
            const updated = await dataAccess.getOne(updatedSq, handle.trx);
            jsonRow = await JSONDOConverter.transformEntityToJSON(
                updated ? updated.toObject() : existing.toObject(), entity
            );

            await TransactionManager.commitTxn(handle);
        } catch (err) {
            await TransactionManager.rollbackTxn(handle);
            return request.response.status(500).json({
                response_status: { status: 'failed', message: err.message }
            });
        }

        // Phase 2 — afterUpdate fires AFTER commit; DB write is durable
        await ListenerDispatcher.dispatch('afterUpdate', entity, jsonRow, req);

        return request.response.status(200).json(
            ResponseTransformer.transform(entity, 'edit', jsonRow)
        );
    }

    /**
     * DELETE — removes a record and cascade-deletes sub-entities.
     *
     * Cascade delete (Path B — raw DELETE WHERE, no sub-entity listeners):
     *   For each collection field on the entity where deleteMode === "cascade":
     *     DELETE FROM <childTable> WHERE <fkCol> = <parentId>
     *   This runs INSIDE the transaction so it rolls back with the parent delete.
     *
     * Transaction lifecycle:
     *   Phase 1 (inside txn): cascade deletes + beforeDelete + DB DELETE
     *   Phase 2 (after commit): afterDelete
     */
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

        // Fetch existing before the transaction — read-only, no txn needed
        const fetchSq = new SelectQueryImpl(Table.getTable(tableName));
        fetchSq.addSelectColumns(this._buildSelectColumns(entity));
        fetchSq.setCriteria(Criteria.eq(Column.getColumn(tableName, pkColumn), entityId));
        const existing = await dataAccess.getOne(fetchSq);

        if (!existing) {
            return request.response.status(404).json({
                response_status: { status: 'failed', message: `${entity.getName()} not found` }
            });
        }

        // ── Transaction lifecycle ─────────────────────────────────────────────
        const handle = await TransactionManager.beginTxn();
        try {
            // Cascade delete sub-entities (Path B: raw DELETE WHERE, inside txn)
            await this._cascadeDeleteSubEntities(entityId, entity, handle.trx);

            await ListenerDispatcher.dispatch('beforeDelete', entity, { id: entityId }, req);

            const dobj = dataAccess.constructDataObject();
            dobj.deleteRow(existing);
            await dataAccess.delete(dobj, handle.trx);

            await TransactionManager.commitTxn(handle);
        } catch (err) {
            await TransactionManager.rollbackTxn(handle);
            return request.response.status(500).json({
                response_status: { status: 'failed', message: err.message }
            });
        }

        // Phase 2 — afterDelete fires AFTER commit; DB write is durable
        await ListenerDispatcher.dispatch('afterDelete', entity, { id: entityId }, req);

        return request.response.status(200).json({
            response_status: {
                status:  'success',
                message: `${entity.getName()} deleted successfully`
            }
        });
    }

    async handleOperation(request) {
        throw new Error(
            `handleOperation not implemented for ${request.entity.getName()}. Override in your domain handler.`
        );
    }

    async getAllowedValues(request) {
        throw new Error(
            `getAllowedValues not implemented for ${request.entity.getName()}. Override in your domain handler.`
        );
    }
}

module.exports = PreDefaultEntityHandler;
