'use strict';

/**
 * DefaultEntityValidator
 *
 * Master 7-stage validation pipeline. Every entity request (POST/PUT) passes
 * through this pipeline before any DB write occurs.
 *
 * Pipeline stages (in order):
 *   1. fillRefs         → inject parent FK from NavigationInfo for sub-entity ADD;
 *                          resolve ref entity IDs supplied as {name:...} (Phase 2)
 *   2. fillDefaults     → apply defaultValue from entity config; resolve $placeholders
 *   3. checkRefIDs      → verify that every ref entity FK ID exists in its target table
 *   4. basicValidation  → nullable checks; max-size enforcement; regex constraints
 *   5. diff             → compute changed field set for partial PUT updates (Phase 2)
 *   6. validate         → custom business rule override point for domain validators
 *   7. preProcess       → data enrichment override point before DB write
 *
 * Ref-entity rules (DOC-01 §2, §7):
 *   - A field with "entity" set and standaloneCRUD=false is a REF field.
 *   - Input arrives as {"status": {"id": 301}} — the .id is the FK value.
 *   - checkRefIDs() validates the ID exists via dataAccess.getOne() — range-scoped, same as all queries.
 *   - Null is allowed only when field.nullable !== false.
 *
 * Sub-entity parent FK injection (DOC-01 §3.4, internal-api doc §5):
 *   - When NavigationInfo is present (sub-entity request), fillRefs() finds the child
 *     entity's "internal: true" field whose "entity" matches the parent entity name.
 *   - It injects {"id": parentId} into the input data under that field's name.
 *   - This means checkRefIDs() will also validate that the parent record exists.
 *
 * Override pattern for domain validators:
 *   class WorklogValidator extends DefaultEntityValidator {
 *       async validate(apiRequest) {
 *           await super.validate(apiRequest);  // ← ALWAYS call super first
 *           // custom business rules here
 *       }
 *   }
 *   module.exports = new WorklogValidator();   // ← singleton export
 */

const PlaceholderResolver = require('../Utils/PlaceholderResolver');
const dataAccess          = require('../Database/ORM/DataAccess');
const { SelectQueryImpl, Criteria, Column, Table } = require('../Database/QueryBuilder');

class DefaultEntityValidator {

    // ── Master pipeline ───────────────────────────────────────────────────────

    /**
     * Runs all 7 validation stages in order.
     * Called by PreDefaultEntityHandler before any DB write.
     *
     * @param {APIRequest} apiRequest
     * @returns {Promise<true>}
     * @throws {Error} on any validation failure
     */
    async validatePipeline(apiRequest) {
        await this.fillRefs(apiRequest);
        await this.fillDefaults(apiRequest);
        await this.checkRefIDs(apiRequest);
        await this.basicValidation(apiRequest);
        await this.diff(apiRequest);
        await this.validate(apiRequest);
        await this.preProcess(apiRequest);
        return true;
    }

    // ── Stage 1: fillRefs ─────────────────────────────────────────────────────

    /**
     * Two responsibilities:
     *
     * A) Parent FK injection for sub-entity ADD (NavigationInfo present):
     *    Finds the child entity's internal FK field (entity=parentName, internal=true),
     *    injects {"id": parentId} into the input data so the handler can write the FK column.
     *
     * B) Phase 2 — by-name ref resolution (not yet implemented):
     *    {"status": {"name": "Open"}} → look up ID → {"status": {"id": 301, "name": "Open"}}
     *
     * @param {APIRequest} apiRequest
     */
    async fillRefs(apiRequest) {
        const navInfo    = apiRequest.navigationInfo;
        const entityName = apiRequest.entity.getName();
        const rawInput   = apiRequest.inputData ? apiRequest.inputData.getEntityData() : {};
        if (!rawInput) return;

        // Normalise: input may be entity-keyed {"request": {...}} or flat {...}
        const entityData = rawInput[entityName] || rawInput;

        // ── A) Parent FK injection ────────────────────────────────────────────
        if (navInfo) {
            const parentEntityName = navInfo.getParentEntity()
                ? navInfo.getParentEntity().getName()
                : null;
            const parentId = navInfo.getParentEntityId();

            if (parentEntityName && parentId != null) {
                const fields = apiRequest.entity.getFields();

                // Find the child entity's field that:
                //   1. references the parent entity  (field.refEntity === parentEntityName)
                //   2. is marked internal            (field.isInternal === true)
                // This field holds the parent FK column (e.g. "request_id" → notes.request_id)
                for (const field of Object.values(fields)) {
                    if (field.refEntity === parentEntityName && field.isInternal) {
                        // Inject the parent reference into the input data.
                        // The format {"id": parentId} is consistent with how clients send ref entities
                        // and how checkRefIDs() / JSONDOConverter expect ref field values.
                        if (entityData[field.name] === undefined) {
                            entityData[field.name] = { id: parentId };
                            console.log(
                                `[Validator] fillRefs: injected parent FK ` +
                                `${field.name}={id:${parentId}} (${parentEntityName}→${entityName})`
                            );
                        }
                        break; // only one parent FK field per sub-entity level
                    }
                }
            }
        }

        // ── B) Phase 2: by-name ref resolution (stub) ────────────────────────
        // For each ref field where value is {"name": "Open"} (no .id), resolve to ID.
        // Not implemented in Phase 1 — clients must supply the ID.
    }

    // ── Stage 2: fillDefaults ─────────────────────────────────────────────────

    /**
     * Applies defaultValue from entity config for absent fields.
     * Resolves $placeholder strings (e.g. $now, $currentUser, $currentTenant).
     *
     * @param {APIRequest} apiRequest
     */
    async fillDefaults(apiRequest) {
        const entityName   = apiRequest.entity.getName();
        const rawInputData = apiRequest.inputData ? apiRequest.inputData.getEntityData() : {};
        const entityData   = (rawInputData && rawInputData[entityName]) ? rawInputData[entityName] : (rawInputData || {});
        const fields       = apiRequest.entity.getFields();
        // Note: no `req` needed — PlaceholderResolver reads from RequestContext ALS directly

        for (const field of Object.values(fields)) {
            // 1. Apply defaultValue when field is absent from input
            if (entityData[field.name] === undefined && field.defaultValue !== undefined) {
                entityData[field.name] = field.defaultValue;
                console.log(
                    `[Validator] fillDefaults: applied default '${field.defaultValue}' to '${field.name}'`
                );
            }

            // 2. Resolve $placeholder strings via PlaceholderResolver (reads from RequestContext ALS)
            if (typeof entityData[field.name] === 'string' && entityData[field.name].startsWith('$')) {
                const original = entityData[field.name];
                const resolved = PlaceholderResolver.resolve(original);
                console.log(
                    `[Validator] fillDefaults: resolved '${original}' → '${resolved}' for '${field.name}'`
                );
                entityData[field.name] = resolved;
            }
        }
    }

    // ── Stage 3: checkRefIDs ──────────────────────────────────────────────────

    /**
     * Validates that every ref entity field value (non-standalone) points to an
     * existing record in the referenced entity's table.
     *
     * Uses dataAccess.getOne() — applies the full tenant range scoping (rangeStart/rangeEnd)
     * from RequestContext, exactly like all other entity queries. Ref entities (status,
     * priority, category, parent records) are all org-partitioned via ID ranges; they are
     * NOT global/shared tables. An FK ID from a different org will fall outside the range
     * and correctly return null → validation failure.
     *
     * Rules:
     *   - Field must have refEntity set and standaloneCRUD=false to be checked.
     *   - Internal FK fields (isInternal=true) ARE checked — they were injected by fillRefs()
     *     and we want to confirm the parent record exists.
     *   - Value can be {"id": X} (object) or a plain number X — both are accepted.
     *   - Null/undefined: allowed if field.nullable !== false; throws if mandatory.
     *   - If ID not found (or out of range): throws with a clear field-level message.
     *
     * @param {APIRequest} apiRequest
     */
    async checkRefIDs(apiRequest) {
        const entityName = apiRequest.entity.getName();
        const rawInput   = apiRequest.inputData ? apiRequest.inputData.getEntityData() : {};
        const entityData = (rawInput && rawInput[entityName]) ? rawInput[entityName] : (rawInput || {});
        const fields     = apiRequest.entity.getFields();
        const op         = apiRequest.operation;   // 'GET' | 'POST' | 'PUT' | 'DELETE'

        // Only run ref validation on write operations
        if (op !== 'POST' && op !== 'PUT') return;

        for (const field of Object.values(fields)) {
            // Only check ref fields (entity set, not a standalone sub-entity collection)
            if (!field.refEntity || field.standaloneCRUD || field.isCollection) continue;

            const rawValue = entityData[field.name];

            // Extract FK id from either {"id": X} or plain number X
            let fkId = null;
            if (rawValue !== null && rawValue !== undefined) {
                if (typeof rawValue === 'object' && rawValue !== null) {
                    fkId = rawValue.id ?? null;
                } else if (typeof rawValue === 'number' || typeof rawValue === 'string') {
                    fkId = rawValue;
                }
            }

            // Mandatory check
            if ((fkId === null || fkId === undefined) && field.nullable === false) {
                throw new Error(
                    `Mandatory ref field missing: '${field.name}' (${field.refEntity} ID required)`
                );
            }

            // Skip null if field is nullable
            if (fkId === null || fkId === undefined) continue;

            // Look up the ref entity definition to find its table and PK column
            const refEntity = field.getRefEntity ? field.getRefEntity() : null;
            if (!refEntity) {
                console.warn(
                    `[Validator] checkRefIDs: ref entity '${field.refEntity}' not registered — skipping check for '${field.name}'`
                );
                continue;
            }

            const refTable   = refEntity.getTableName();
            const refPkField = refEntity.getIdentifierField();
            if (!refTable || !refPkField) {
                console.warn(
                    `[Validator] checkRefIDs: cannot determine table/PK for '${field.refEntity}' — skipping`
                );
                continue;
            }

            const refPkCol = refPkField.getColumnName();

            // getOne() applies tenant range scoping from RequestContext — same as all entity reads.
            // A cross-org FK ID will fall outside the range and return null → caught below.
            const sq = new SelectQueryImpl(Table.getTable(refTable));
            sq.setCriteria(Criteria.eq(Column.getColumn(refTable, refPkCol), fkId));

            const row = await dataAccess.getOne(sq);
            if (!row) {
                throw new Error(
                    `Invalid value for field '${field.name}': ` +
                    `${field.refEntity} with ID ${fkId} does not exist`
                );
            }

            console.log(
                `[Validator] checkRefIDs: '${field.name}' → ${field.refEntity}#${fkId} exists ✓`
            );
        }
    }

    // ── Stage 4: basicValidation ──────────────────────────────────────────────

    /**
     * Entity-level constraint validation:
     *   - Identifier (PK) must not be supplied by client on POST
     *   - Nullable checks for mandatory non-ref fields
     *   - Entity config regex constraint check
     *   - Data Dictionary max-size enforcement
     *
     * Ref entity fields are validated in checkRefIDs() — not re-validated here.
     * Sub-entity collection fields (standaloneCRUD) are skipped entirely.
     *
     * @param {APIRequest} apiRequest
     */
    async basicValidation(apiRequest) {
        // Skip if caller opted out (e.g. internal cascade calls)
        if (apiRequest.requestPolicy && apiRequest.requestPolicy.skipBasicValidation) {
            console.log('[Validator] basicValidation: skipped (skipBasicValidation=true)');
            return;
        }

        const entityName = apiRequest.entity.getName();
        const rawInput   = apiRequest.inputData ? apiRequest.inputData.getEntityData() : {};
        const entityData = (rawInput && rawInput[entityName]) ? rawInput[entityName] : (rawInput || {});
        const fields     = apiRequest.entity.getFields();
        const tableName  = apiRequest.entity.getTableName();
        const op         = apiRequest.operation;

        console.log('[Validator] basicValidation start…');

        // PUT requires an entity ID in the URL path
        if ((op === 'PUT' || op === 'DELETE') && !apiRequest.entityId) {
            throw new Error(
                `Mandatory identifier missing from URL path for ${op} operation`
            );
        }

        const isPut = (op === 'PUT');
        const DataDictionaryParser = require('../Registry/DataDictionaryParser');

        for (const field of Object.values(fields)) {
            // Skip sub-entity collection fields — they have their own endpoints
            if (field.standaloneCRUD || field.isCollection) continue;

            // Skip internal fields — they are injected by fillRefs(), not from client input
            // Note: on PUT, internal ref fields (parent FK) should never be updatable from client
            if (field.isInternal && isPut) continue;

            // Skip ref entity fields — nullable+existence already checked in checkRefIDs()
            if (field.refEntity && !field.standaloneCRUD) continue;

            const value = entityData[field.name];

            // Nullable check — identifier is auto-generated; PUT skips absent fields (partial update)
            if (field.nullable === false && !field.isIdentifier && !isPut) {
                if (value === undefined || value === null || value === '') {
                    throw new Error(`Mandatory field missing: ${field.name}`);
                }
            }

            if (value !== undefined && value !== null) {
                // Entity config regex constraint
                if (field.constraints && field.constraints.regex) {
                    try {
                        const rx = new RegExp(field.constraints.regex);
                        if (!rx.test(value.toString())) {
                            throw new Error(
                                `Constraint violation: field '${field.name}' failed regex validation`
                            );
                        }
                    } catch (regexErr) {
                        if (regexErr.message.startsWith('Constraint violation')) throw regexErr;
                        console.warn(
                            `[Validator] Invalid regex for field ${field.name}: ${regexErr.message}`
                        );
                    }
                }

                // Data Dictionary max-size enforcement
                const maxSize = DataDictionaryParser.getColumnProperty(tableName, field.getColumnName ? field.getColumnName() : field.name, 'max-size');
                if (maxSize !== null && typeof value === 'string' && value.length > maxSize) {
                    throw new Error(
                        `Field '${field.name}' length (${value.length}) exceeds max size of ${maxSize}`
                    );
                }
            }
        }

        console.log('[Validator] basicValidation passed.');
    }

    // ── Stage 5: diff ─────────────────────────────────────────────────────────

    /**
     * Computes the set of changed fields for partial PUT updates.
     * Phase 2 — not yet implemented. Handled implicitly by Row.isDirty() in the handler.
     *
     * @param {APIRequest} apiRequest
     */
    async diff(apiRequest) {
        // Phase 2: FieldDiff.getDiff(oldBean, newBean) — tracks per-field old/new values
        // Used by validators and listeners to react only to changed fields.
    }

    // ── Stage 6: validate ─────────────────────────────────────────────────────

    /**
     * Custom business rule override point.
     * Domain validators extend DefaultEntityValidator and override this method.
     * Always call super.validate(apiRequest) first.
     *
     * @param {APIRequest} apiRequest
     */
    async validate(apiRequest) {
        // Override point — default: no-op
    }

    // ── Stage 7: preProcess ───────────────────────────────────────────────────

    /**
     * Data enrichment before DB write — override point.
     * Use to set computed fields (e.g. slugs, denormalised counts, timestamps)
     * that depend on the final validated input state.
     *
     * @param {APIRequest} apiRequest
     */
    async preProcess(apiRequest) {
        // Override point — default: no-op
    }
}

// Export as a singleton — domain validators export `new DomainValidator()` on top of this
module.exports = new DefaultEntityValidator();
