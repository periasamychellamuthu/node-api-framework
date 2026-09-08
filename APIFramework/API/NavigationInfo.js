'use strict';

/**
 * NavigationInfo — parent-child entity context carrier.
 *
 * Constructed by EntityLocator (APIRequest.js) as it walks URL segments.
 * Represents one level of parent context. For deeply nested paths, each level
 * wraps the previous as grandParentInfo (a linked list of ancestors).
 *
 * Example — /requests/123/notes/456/attachments:
 *   navInfo.parentEntity      = request_note,   parentEntityId = 456
 *   navInfo.grandParentInfo
 *     .parentEntity           = request,         parentEntityId = 123
 *     .grandParentInfo        = null
 *
 * Used by:
 *   - PreDefaultEntityHandler  — parent FK injection, scoping, cascade delete
 *   - DefaultEntityValidator   — fillRefs() injects parent FK into input data
 *   - JSONDOConverter           — skips standalone_crud fields in parent response
 *   - Listeners                 — access parent context for history propagation
 *
 * Construction (EntityLocator):
 *   navInfo = new NavigationInfo(parentEntity, parentEntityId, refField, grandParentInfo)
 *
 * Manual construction (internal / programmatic calls):
 *   const navInfo = new NavigationInfo(parentEntity, parentId, refField, null);
 */
function NavigationInfo(parent, parentId, refField, grandParentInfo) {
    this.parentEntity    = parent;
    this.parentEntityId  = parentId;
    this.refField        = refField;       // The collection field on the parent entity
    this.grandParentInfo = grandParentInfo || null;
    this.parentBean      = null;           // Populated lazily if parent record is fetched

    // ── Accessors ─────────────────────────────────────────────────────────────

    /**
     * Returns the parent Entity definition object.
     * e.g. for /requests/123/notes — returns the "request" Entity.
     */
    this.getParentEntity = function () {
        return this.parentEntity;
    };

    /**
     * Returns the numeric parent record ID.
     * e.g. for /requests/123/notes — returns 123.
     *
     * Bug fix: original implementation was missing `return`.
     */
    this.getParentEntityId = function () {
        return this.parentEntityId;
    };

    /**
     * Returns the field object on the parent entity that declares this sub-entity
     * collection. e.g. the "notes" field on the "request" entity.
     * null when NavigationInfo was constructed without a refField (bare entity navigation).
     */
    this.getRefField = function () {
        return this.refField;
    };

    /**
     * Returns the grandparent NavigationInfo (one level up), or null if this
     * is already the top-level parent.
     *
     * Used for deeply nested sub-entity paths:
     *   /requests/123/notes/456/attachments
     *   → navInfo.getParentNavInfo().getParentEntity() === request
     */
    this.getParentNavInfo = function () {
        return this.grandParentInfo;
    };
}

module.exports = NavigationInfo;
