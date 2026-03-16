var APIRequest = require('./API/APIRequest');
function DefaultRouterHandler() {
    this.handleRequest = function (req, res) {
        const apiRequest = new APIRequest(req, res);
        if (!apiRequest.entity) {
            return res.status(400).send({
                "status": 400,
                "error": "Invalid input: Entity not found"
            });
        }
        var handler = apiRequest.entity.getHandlerInstance();
        handler.handleAPICall(apiRequest);
    }
}

module.exports = new DefaultRouterHandler();