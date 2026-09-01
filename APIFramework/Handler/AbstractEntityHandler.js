const APIHandler = require('./APIHandler');

/**
 * Handles cross-cutting concerns like licensing, core criteria, and authentication
 * before delegating to the actual logic layer.
 */
class AbstractEntityHandler extends APIHandler {
    constructor() {
        super();
        if (this.constructor === AbstractEntityHandler) {
            throw new Error("AbstractEntityHandler is an abstract class and cannot be instantiated.");
        }
    }

    async handleAPICall(request) {
        const method = request.operation.toUpperCase();
        switch (method) {
            case 'POST':
                return await this.add(request);
            case 'PUT':
                return await this.edit(request);
            case 'GET':
                if (request.entityId) {
                    return await this.getEntity(request);
                }
                return await this.getList(request);
            case 'DELETE':
                return await this.delete(request);
            default:
                throw new Error(`Unsupported operation type: ${method}`);
        }
    }
}

module.exports = AbstractEntityHandler;
