var APIRequest = require('./API/APIRequest');
const EntityConfigLoader = require('./Configuration/EntityConfigLoader');

function DefaultRouterHandler() {
    this.handleRequest = async function (req, res) {
        // Security checks (URL whitelisting, role check, input_data template validation)
        // are handled by XMLSecurityMiddleware in the middleware chain before this point.

        // 2. Parse URL to Extract Entity & Operation
        const segments = req.path.split('/').filter(s => s.length > 0);
        let entityPath = `/${segments[0]}`;

        // Handling /api/v1 prefix gracefully if present
        if (segments.length >= 3 && segments[0] === 'api' && segments[1] === 'v1') {
            entityPath = `/${segments[2]}`;
        }

        const entityConfig = EntityConfigLoader.getAllEntities().find(e => e.path === entityPath);
        if (!entityConfig) {
            return res.status(404).json({ error: "Endpoint not found: No matching entity definition." });
        }

        req._entityConfig = entityConfig;

        const method = req.method.toLowerCase();
        let isCollection = true;
        // Basic check if it's an instance endpoint /users/1
        if ((segments[0] === 'api' && segments.length > 3) || (segments[0] !== 'api' && segments.length > 1)) {
            isCollection = false;
        }

        const lastSeg = segments[segments.length - 1];
        if (lastSeg === '_metainfo') req._operation = 'metainfo';
        else if (lastSeg === '_links') req._operation = 'links';
        else if (lastSeg.startsWith('_')) req._operation = lastSeg.substring(1);
        else {
            if (method === 'get') req._operation = 'GET';
            else if (method === 'post') req._operation = 'POST';
            else if (method === 'put') req._operation = 'PUT';
            else if (method === 'delete') req._operation = 'DELETE';
            else req._operation = 'unknown';
        }

        const apiRequest = new APIRequest(req, res);
        apiRequest.operation = req._operation;

        if (!apiRequest.entity) {
            return res.status(400).send({
                "status": 400,
                "error": "Invalid input: Entity not found"
            });
        }

        var handler = apiRequest.entity.getHandlerInstance();
        // Kickoff handler pipeline correctly
        handler.handleAPICall(apiRequest);
    }
}

module.exports = new DefaultRouterHandler();