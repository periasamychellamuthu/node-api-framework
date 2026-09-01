const APIRequest      = require('./API/APIRequest');
const APIConstants    = require('./API/constants');
const RequestContext   = require('./Context/RequestContext');
const { fail }        = require('./Utils/ResponseUtil');

async function handleRequest(req, res) {
    req._strippedPath = APIConstants.stripOrgPrefix(req.path);

    const apiRequest = new APIRequest(req, res);

    if (!apiRequest.entity || !apiRequest.entity.getHandlerInstance) return fail(res, 404, 4004, 'Entity not found.');

    // Wrap the entire handler call inside RequestContext.
    // req.$credentials was populated by OrgContextFilter and contains:
    //   { orgId, memberId, rangeStart, rangeEnd, roles, authAccountId }
    // From this point, DataAccess.get() / getOne() automatically inject
    // the range criteria on every query — no manual req.rangeStart passing needed.
    // apiRequest is also stored so any layer can call RequestContext.getAPIRequest()
    // without needing it threaded through as a parameter.
    return RequestContext.run(
        req.$credentials,
        apiRequest,
        () => apiRequest.entity.getHandlerInstance().handleAPICall(apiRequest)
    );
}

module.exports = { handleRequest };