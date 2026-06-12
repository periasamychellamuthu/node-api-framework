/**
 * Base interface class representing the standard contract for any API Handler.
 * Based on the SDP FW APIHandler contract.
 */
class APIHandler {
    constructor() {
        if (this.constructor === APIHandler) {
            throw new Error("APIHandler is an abstract interface and cannot be instantiated directly.");
        }
    }

    /**
     * @param {APIRequest} request 
     * @returns {Promise<APIResult>}
     */
    async add(request) { throw new Error("Method 'add()' must be implemented."); }

    /**
     * @param {APIRequest} request 
     * @returns {Promise<APIResult>}
     */
    async edit(request) { throw new Error("Method 'edit()' must be implemented."); }

    /**
     * @param {APIRequest} request 
     * @returns {Promise<APIResult>}
     */
    async getList(request) { throw new Error("Method 'getList()' must be implemented."); }

    /**
     * @param {APIRequest} request 
     * @returns {Promise<APIResult>}
     */
    async getEntity(request) { throw new Error("Method 'getEntity()' must be implemented."); }

    /**
     * @param {APIRequest} request 
     * @returns {Promise<APIResult>}
     */
    async delete(request) { throw new Error("Method 'delete()' must be implemented."); }

    /**
     * @param {APIRequest} request 
     * @returns {Promise<APIResult>}
     */
    async handleOperation(request) { throw new Error("Method 'handleOperation()' must be implemented."); }

    /**
     * @param {APIRequest} request 
     * @returns {Promise<APIResult>}
     */
    async getAllowedValues(request) { throw new Error("Method 'getAllowedValues()' must be implemented."); }

    /**
     * Main entry point to route the operation to the appropriate CRUD method.
     * @param {APIRequest} request 
     */
    async handleAPICall(request) {
        throw new Error("Method 'handleAPICall()' must be implemented.");
    }
}

module.exports = APIHandler;
