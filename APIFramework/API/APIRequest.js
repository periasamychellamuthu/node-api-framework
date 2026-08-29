const APIConstants = require('./constants');
var Entity = require('./Entity');
const NavigationInfo = require('./NavigationInfo');
const APIContext = require('./APIContext');
const InputData = require('./InputData');

function APIRequest(request, response) {

    const rawPath     = request._strippedPath || (request.baseUrl + (request.url === '/' ? '' : request.url));
    var locatorResult = new EntityLocator(rawPath);

    this.operation    = request.method;
    this.result       = {};
    this.response     = response;
    this.isSubRequest = false;

    this.entity                    = locatorResult.currentEntity;
    this.entityId                  = locatorResult.currentEntityId;
    this.firstTokenInPath          = locatorResult.firstTokenInPath;
    this.navigationInfo            = locatorResult.navigationInfo;
    this.convenienceOperationName  = locatorResult.convenienceOperationName  || null;
    this.convenienceOperationParam = locatorResult.convenienceOperationParam || null;

    this.context   = new APIContext(request);
    this.inputData = new InputData(request.body, request.query);

    this.dataObject       = null;
    this.entityBeanObject = null;
}

/**
 * getURLTokens
 *
 * Strips the /api and /v1 prefixes from a path then splits into non-empty segments.
 *
 *   /api/v1/members/42        → ["members", "42"]
 *   /api/v1/modules/x/fields  → ["modules", "x", "fields"]
 */
function getURLTokens(url) {
    url = url.replace(APIConstants.API_PATH,    '');   // remove /api
    url = url.replace(APIConstants.API_VERSION, '');   // remove /v1
    return url.split('/').filter(function (element) { return element !== ''; });
}

/**
 * isMetaInfoCall
 *
 * Returns true when the URL ends with the _metainfo convenience op segment.
 */
function isMetaInfoCall(path) {
    var tokens = getURLTokens(path);
    return tokens.length > 0 && tokens[tokens.length - 1] === '_metainfo';
}

/**
 * EntityLocator
 *
 * Tokenises the stripped URL path (/api/v1/...) and walks each segment to resolve:
 *
 *   currentEntity           — the leaf entity this request targets
 *   currentEntityId         — numeric id of that entity (null = collection)
 *   convenienceOperationName — e.g. "metainfo", "links", "close" (token starting with _)
 *   convenienceOperationParam — additional param(s) following a convenience op
 *   navigationInfo          — linked chain of NavigationInfo for nested paths
 *   firstTokenInPath        — the first URL segment (debug / logging)
 *
 * Walk rules (mirrors SDP URIParseResult.getURIParseResult):
 *
 *   Token 0 (first segment):
 *     Must match an entity by path ("members" → Entity.getEntityByPath("/members")).
 *     If not found → entity remains null (caller returns 404).
 *
 *   Token i (i ≥ 1):
 *     a. If a convenience op was already set and this is NOT a metainfo call:
 *          append token to convenienceOperationParam and continue.
 *     b. If token is purely numeric:
 *          set curEntityId.
 *     c. If token starts with '_':
 *          treat as convenience operation name (strip leading _).
 *          tokens WITHOUT the _ prefix are also accepted for backwards compatibility
 *          but flagged via operationWithoutUnderscore.
 *     d. If token matches a field name on curEntity (field.standaloneCRUD = true):
 *          push NavigationInfo(curEntity, curEntityId, field) and navigate to refEntity.
 *     e. If token matches a field name on curEntity (field.standaloneCRUD = false):
 *          field must have a refEntity or allowedValues → set convenienceOperationName
 *          to "allowed_values".
 *     f. None of the above → throw INVALID_URL (unknown segment).
 *
 * Versatile Phase 1 scope notes (vs SDP):
 *   • Dynamic entities (isDynamicEntity)  — not implemented; skipped.
 *   • UDF field holders (isUDFFieldHolder) — not implemented; skipped.
 *   • ENUM field type detection           — not implemented; "allowed_values" covers both.
 *   • operationWithoutUnderscore flag     — kept for forward compat; not enforced yet.
 */
function EntityLocator(path) {

    var tokenList = getURLTokens(path);
    var size      = tokenList.length;

    this.currentEntity           = null;
    this.currentEntityId         = null;
    this.navigationInfo          = null;
    this.convenienceOperationName  = null;
    this.convenienceOperationParam = null;
    this.firstTokenInPath          = null;
    this.operationWithoutUnderscore = false;  // SDP compat flag

    if (size === 0) {
        return;  // empty path — caller will handle null entity
    }

    // ── Token 0: root entity resolution ─────────────────────────────────────
    this.firstTokenInPath = tokenList[0];
    this.currentEntity    = Entity.getEntityByPath(this.firstTokenInPath);

    // If the first token does not resolve to an entity the URL is invalid.
    // Caller (DefaultRouterHandler) handles the null case with a 404.
    if (!this.currentEntity) {
        return;
    }

    var curEntity   = this.currentEntity;
    var curEntityId = null;
    var navInfo     = null;
    var metaInfoCall = isMetaInfoCall(path);

    // ── Token i (i ≥ 1): walk remaining segments ─────────────────────────────
    for (var i = 1; i < size; i++) {
        var token = tokenList[i];

        // ── (a) Convenience op already set — collect param tokens ────────────
        // If a previous token set a convenience op and this is not a metainfo
        // call, remaining tokens are parameters to that op (e.g. /assign/admin).
        // Exception: "allowed_values" continues to accept a trailing numeric id.
        var id = parseInt(token, 10);
        var isNumeric = !isNaN(id) && String(id) === token;  // strict integer check

        if (!metaInfoCall
                && this.convenienceOperationName !== null
                && (this.convenienceOperationName !== 'allowed_values' || (!isNumeric || i !== size - 1))) {
            this.convenienceOperationParam = (this.convenienceOperationParam
                ? this.convenienceOperationParam + ',' : '') + token;
            continue;
        }

        // ── (b) Numeric id ───────────────────────────────────────────────────
        if (isNumeric) {
            curEntityId = id;
            curEntity.setId(curEntityId);
            continue;
        }

        // ── (c) Convenience operation token (starts with _) ──────────────────
        if (token.startsWith('_')) {
            // Strip the leading _ to get the operation name.
            // curEntity.getOperationName() can map legacy names if needed.
            this.convenienceOperationName = token.substring(1);
            continue;
        }

        // ── (d/e) Field name on curEntity ────────────────────────────────────
        var field = curEntity.getFieldByName(token);

        if (field) {
            if (field.standaloneCRUD) {
                // ── (d) Standalone sub-entity navigation ─────────────────────
                // e.g. /members/42/roles  where roles is a standaloneCRUD collection
                // Push current entity+id into NavigationInfo and switch to child entity.
                navInfo     = new NavigationInfo(curEntity, curEntityId, field, navInfo);
                curEntity   = field.getRefEntity();
                curEntityId = null;
            } else {
                // ── (e) Non-standalone ref field or allowed-values field ──────
                // These fields expose allowed values (picklist / reference lookup)
                // but do NOT have their own CRUD lifecycle.
                if (field.allowedValues || field.refEntity) {
                    this.convenienceOperationName = 'allowed_values';
                } else {
                    // Field exists but is neither standalone nor ref/allowed — invalid
                    this.currentEntity = null;  // signal invalid URL
                    return;
                }
                navInfo     = new NavigationInfo(curEntity, curEntityId, field, navInfo);
                curEntity   = field.getRefEntity();
                curEntityId = null;
            }
        } else {
            // ── (f) Token without _ that does not match any field ────────────
            // Three possible interpretations:
            //   1. A known entity path segment — sub-entity navigation
            //      e.g. "records" in /modules/it_procurement/records
            //   2. A scope/slug qualifier — a value (handle, name) sitting between
            //      two entity segments in the URL, e.g. "it_procurement" in
            //      /modules/it_procurement/records.  These are NOT the last token —
            //      something follows them.  Skip silently; the router has already
            //      captured the correct entity via right-to-left scan.
            //   3. A legacy convenience op without the _ prefix (SDP back-compat).
            //      These are the last token with nothing following.
            var asEntity = Entity.getEntityByPath(token);
            if (asEntity) {
                // Case 1: known entity segment — navigate into it.
                // Push parent context into NavigationInfo so handlers can scope queries.
                navInfo     = new NavigationInfo(curEntity, curEntityId, null, navInfo);
                curEntity   = asEntity;
                curEntityId = null;
            } else if (i < size - 1) {
                // Case 2: not the last token → scope slug (e.g. "it_procurement").
                // Skip — router already resolved the correct leaf entity and id.
                // Do not set convenienceOperationName; it is not an operation.
            } else {
                // Case 3: last token, unrecognised → legacy convenience op.
                this.operationWithoutUnderscore = true;
                this.convenienceOperationName   = token;
            }
        }
    }

    // ── Finalise ─────────────────────────────────────────────────────────────
    this.currentEntity   = curEntity;
    this.currentEntityId = curEntityId;
    this.navigationInfo  = navInfo;
}

module.exports = APIRequest;