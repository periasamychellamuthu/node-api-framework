class EntityTransformer {
    constructor() {
        if (this.constructor === EntityTransformer) {
            throw new Error("EntityTransformer is an abstract class and cannot be instantiated.");
        }
    }

    /**
     * Translates the incoming request JSON into internal system data concepts.
     * Overridden per entity module for custom logic.
     * @param {APIRequest} request 
     */
    async transformJSONToEntity(request) {
        throw new Error("Method 'transformJSONToEntity()' must be implemented.");
    }

    /**
     * Translates the database internal `DataObject` into outbound API JSON context.
     * Overridden per entity module for custom logic.
     * @param {DataObject} dataObject 
     */
    async transformEntityToJSON(dataObject) {
        throw new Error("Method 'transformEntityToJSON()' must be implemented.");
    }

    /**
     * Resolves reference objects like FK to display string names.
     */
    async resolveReferenceFields(dataObject) {
        // ...
    }
}

module.exports = EntityTransformer;
