const EntityTransformer = require('./EntityTransformer');

/**
 * 2,019 lines in Java architecture reduced to its core capabilities.
 * It is the central engine for transforming `EntityBeanObject` (JSON) to `DataObject` (DB)
 */
class JSONDOConverter extends EntityTransformer {
    constructor() {
        super();
    }

    /**
     * Generically maps fields from their JSON name to their SQL Database column name.
     */
    async transformJSONToEntity(request) {
        const entityName = request.entity.getName();
        console.log(`[JSONDOConverter] Transforming JSON Request to DataObject for Entity: ${entityName}`);

        let dbObject = {};
        const rawInputData = request.inputData ? request.inputData.getEntityData() : {};
        if (!rawInputData) return dbObject;

        // Input arrives as { "user": { "username": "...", "email": "..." } }
        // Unwrap the entity-keyed wrapper to get the flat field map
        const entityData = rawInputData[entityName] || rawInputData;

        console.log(`[JSONDOConverter] entityData ->`, entityData);

        const fields = request.entity.getFields();
        for (const [key, fieldInfo] of Object.entries(fields)) {
            // Skip identifier fields — the PK is assigned by SequenceGenerator, not from input
            if (fieldInfo.isIdentifier) continue;

            if (entityData.hasOwnProperty(fieldInfo.name)) {
                const columnName = fieldInfo.getColumnName();
                dbObject[columnName] = entityData[fieldInfo.name];
            }
        }

        console.log(`[JSONDOConverter] Created dbObject ->`, dbObject);
        return dbObject;
    }

    /**
     * Reverses the SQL query row returns into a structured JSON string.
     */
    async transformEntityToJSON(dataObject, entity) {
        console.log(`[JSONDOConverter] Transforming DataObject to JSON Response for Entity: ${entity.getName()}`);

        let jsonResponse = {};
        const fields = entity.getFields();

        for (const [key, fieldInfo] of Object.entries(fields)) {
            // E.g., SQL returns { USER_NAME: "John" }, output JSON { "name": "John" }
            const columnName = fieldInfo.relationMapping.split('.')[1];
            if (dataObject.hasOwnProperty(columnName)) {
                jsonResponse[fieldInfo.name] = dataObject[columnName];
            }
        }

        // Recursively handle any nested foreign-key entity resolution here
        await this.resolveReferenceFields(jsonResponse);

        return jsonResponse;
    }

    async resolveReferenceFields(jsonResponse) {
        // Dummy block mapping M2M and UDF representations
        // E.g. { "role_id": 5 } -> { "role": { "id": 5, "name": "Admin" } }
        return jsonResponse;
    }
}

// Export as a reusable singleton
module.exports = new JSONDOConverter();
