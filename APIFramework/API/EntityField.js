'use strict';

/**
 * EntityField — runtime representation of a single field from an entity config JSON.
 *
 * Constructed once per field per entity at startup by Entity.setFieldsForEntity().
 * All handler, validator, and transformer layers read field metadata from here.
 *
 * Entity config JSON property → EntityField property mapping:
 *
 *   name                → this.name
 *   relational_mapping  → this.relationMapping          "Table.COLUMN"
 *   is_identifier       → this.isIdentifier             PK field (auto-generated, never from input)
 *   entity              → this.refEntity                ref/sub-entity name (string)
 *   display_key         → this.displayKey               which field of ref entity to show (e.g. "name")
 *   fill_allowed_values → this.allowedValues            expose picklist in GET response
 *   ForeignKey_mapping  → this.foreignKeyMapping        explicit FK override (rarely used)
 *   collection          → this.isCollection             true = 1-to-N (array of children)
 *   standalone_crud     → this.standaloneCRUD           true = child has own CRUD endpoints
 *   delete              → this.deleteMode               "cascade" = cascade delete on parent delete
 *   nullable            → this.nullable                 false = mandatory field
 *   internal            → this.isInternal               true = never exposed in API response
 *   constraints         → this.constraints              { regex, minLength, maxLength }
 *   defaultValue        → this.defaultValue             applied in fillDefaults() when field absent
 *
 * Ref entity field pattern:
 *   A field with "entity" set and standaloneCRUD=false is a REF entity:
 *     - DB stores only the FK ID
 *     - API input:  {"status": {"id": 301}}
 *     - API output: {"status": {"id": 301, "name": "Open"}}
 *
 * Sub-entity field pattern:
 *   A field with "entity" set and standaloneCRUD=true is a SUB entity:
 *     - Accessible via nested URL: /requests/123/worklogs
 *     - NOT included in parent GET response
 *     - The parent field's relational_mapping = "ChildTable.FKColumn" (child table + FK col)
 *
 * Internal FK field pattern (declared on the child entity):
 *   { "name": "request_id", "relational_mapping": "notes.request_id",
 *     "entity": "request", "internal": true }
 *   - Stores the parent FK on the child row
 *   - NOT exposed in API response (internal: true)
 *   - Used by handler to inject parent FK on sub-entity ADD
 *   - Used by handler to build WHERE clause for sub-entity GET LIST
 */
function Field(json) {
    // ── Core identity ─────────────────────────────────────────────────────────

    this.name            = json.name;
    this.relationMapping = json.relational_mapping;   // "Table.COLUMN"

    // ── Identifier (PK) ───────────────────────────────────────────────────────

    // Support both "is_identifier" (Versatile standard) and "identifier" (legacy)
    this.isIdentifier    = json.is_identifier || json.identifier || false;

    // ── Ref / Sub entity ──────────────────────────────────────────────────────

    this.refEntity       = json.entity       || null;   // Referenced entity name
    this.displayKey      = json.display_key  || null;   // Field to show in ref expansion (e.g. "name")

    // ── Collection / standalone CRUD ──────────────────────────────────────────

    // Accept both snake_case (Versatile standard) and camelCase (legacy/back-compat)
    this.isCollection    = json.collection      || json.isCollection   || false;
    this.standaloneCRUD  = json.standalone_crud || json.standaloneCRUD || false;

    // Cascade mode — "cascade" means parent delete cascades to this sub-entity (Path B: raw DELETE WHERE)
    this.deleteMode      = json.delete || null;

    // ── Visibility / access control ───────────────────────────────────────────

    // internal: true → field is never included in API responses (used for FK fields on child entities)
    this.isInternal      = json.internal !== undefined ? json.internal : false;

    // nullable: false → mandatory field; validator throws if absent on POST
    this.nullable        = json.nullable !== undefined ? json.nullable : true;

    // ── Allowed values (picklist) ──────────────────────────────────────────────

    this.allowedValues   = json.fill_allowed_values || false;

    // ── FK mapping override ────────────────────────────────────────────────────

    this.foreignKeyMapping = json.ForeignKey_mapping || null;

    // ── Constraints & defaults ────────────────────────────────────────────────

    this.constraints     = json.constraints  || null;   // { regex, minLength, maxLength }
    this.defaultValue    = json.defaultValue !== undefined ? json.defaultValue : undefined;

    // ── Derived helpers ───────────────────────────────────────────────────────

    /**
     * Returns the table name from relational_mapping ("Table.COLUMN" → "Table").
     * Only valid for fields that have a relational_mapping (non-group-holder fields).
     */
    this.getTableName = function () {
        if (!this.relationMapping) return null;
        return this.relationMapping.split('.')[0];
    };

    /**
     * Returns the column name from relational_mapping ("Table.COLUMN" → "COLUMN").
     */
    this.getColumnName = function () {
        if (!this.relationMapping) return null;
        return this.relationMapping.split('.')[1];
    };

    /**
     * Looks up and returns the referenced Entity object (for ref and sub-entity fields).
     * Returns null if refEntity is not set or the entity is not registered.
     */
    this.getRefEntity = function () {
        if (!this.refEntity) return null;
        const Entity = require('./Entity');
        return Entity.getEntityByName(this.refEntity);
    };

    /**
     * Returns the ref entity name string (the "entity" property value).
     */
    this.getRefEntityName = function () {
        return this.refEntity;
    };

    /**
     * Returns true if this field exposes a picklist via fill_allowed_values.
     */
    this.isAllowedValuesField = function () {
        return this.allowedValues !== false && this.allowedValues !== undefined;
    };

    /**
     * Returns true if this is a ref entity field (has refEntity, not a sub-entity collection).
     * These fields are resolved inline in parent GET responses.
     */
    this.isRefEntityField = function () {
        return !!this.refEntity && !this.standaloneCRUD;
    };

    /**
     * Returns true if this is a sub-entity collection field (has refEntity + standaloneCRUD).
     * These fields have their own CRUD endpoints and are NOT included in parent GET responses.
     */
    this.isSubEntityField = function () {
        return !!this.refEntity && this.standaloneCRUD;
    };
}

module.exports = Field;

module.exports.getRefEntity = function (field) {
    const Entity = require('./Entity');
    return Entity.getEntityByName(field.refEntity);
};

module.exports.getRelationshipField = function (entity, referringEntity) {
    // Returns the field on `entity` that references `referringEntity` (by name).
    // Used by handler._injectParentFK() to find the FK field without iterating manually.
    if (!entity || !referringEntity) return null;
    const fields = entity.getFields ? entity.getFields() : {};
    for (const field of Object.values(fields)) {
        if (field.refEntity === (typeof referringEntity === 'string' ? referringEntity : referringEntity.getName())) {
            return field;
        }
    }
    return null;
};
