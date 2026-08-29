const APIRequest   = require('./API/APIRequest');
const APIConstants = require('./API/constants');

async function handleRequest(req, res) {
    req._strippedPath = APIConstants.stripOrgPrefix(req.path);

    const apiRequest = new APIRequest(req, res);

    if (!apiRequest.entity || !apiRequest.entity.getHandlerInstance) {
        return res.status(404).json({
            response_status: { status_code: 4004, status: 'failed', message: 'Entity not found.' }
        });
    }

    apiRequest.entity.getHandlerInstance().handleAPICall(apiRequest);
}

module.exports = { handleRequest };