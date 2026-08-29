/**
 * APIConstants
 *
 * Shared URL constants and utility used across the framework.
 *
 * Design:
 *   security-api.xml uses full org-scoped paths (/org/:orgHandle/api/v1/...)
 *   for XMLSecurityMiddleware URL whitelisting only.
 *
 *   DefaultRouterHandler strips the org prefix with stripOrgPrefix(), then
 *   further strips API_PATH + API_VERSION to produce bare entity tokens.
 *   Entity configs use short paths ("/members", "/modules", etc.) and are
 *   looked up directly from those bare tokens via EntityMetaDataHolder.
 *
 * Functions intentionally NOT here:
 *   findEntityConfig      — removed: no longer needed; router uses token lookup
 *   stripOrgParamPrefix   — removed: was only needed for findEntityConfig
 *   pathPatternToRegex    — removed: was only needed for findEntityConfig
 */
const APIConst = {

    // Prefix segments stripped from incoming URLs before entity token extraction.
    API_PATH    : '/api',
    API_VERSION : '/v1',

    /**
     * Strips the /org/<handle> prefix from an incoming URL path so the
     * remaining path starts from /api/v1/...
     *
     * Examples:
     *   /org/acme/api/v1/members          → /api/v1/members
     *   /org/acme/api/v1/members/42       → /api/v1/members/42
     *   /org/acme/api/v1/modules/it/records/500 → /api/v1/modules/it/records/500
     *   /api/v1/roles                     → /api/v1/roles   (no-op — no org prefix)
     */
    stripOrgPrefix(urlPath) {
        // Matches /org/<handle>/rest-of-path  (handle = any non-slash token)
        const m = urlPath.match(/^\/org\/[^/]+(\/.*)?$/);
        if (m) {
            return m[1] || '/';   // everything after /org/<handle>
        }
        return urlPath;
    }
};

module.exports = APIConst;