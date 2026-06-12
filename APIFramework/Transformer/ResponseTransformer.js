class ResponseTransformer {
    /**
     * Transforms and wraps the internal response object into the Versatile standard `response_status` envelope format.
     */
    static transform(entityConfig, operation, resultData) {
        console.log(`[ResponseTransformer] Shaping response for ${entityConfig.entityName}:${operation}`);

        // Strip out internal fields if necessary
        const safeData = this.stripInternalFields(entityConfig, resultData);

        // Encapsulate into the Versatile framework standard response
        return {
            response_status: {
                status: 'success',
                message: 'Operation successful'
            },
            [entityConfig.pluralName || entityConfig.entityName]: safeData
        };
    }

    static stripInternalFields(entityConfig, payload) {
        if (!payload) return payload;

        const internalFields = (entityConfig.fields || [])
            .filter(f => f.internal === true)
            .map(f => f.name);

        if (internalFields.length === 0) return payload;

        let dataArray = Array.isArray(payload) ? payload : [payload];
        let cleanedArray = dataArray.map(item => {
            const copy = { ...item };
            internalFields.forEach(field => delete copy[field]);
            return copy;
        });

        return Array.isArray(payload) ? cleanedArray : cleanedArray[0];
    }
}

module.exports = ResponseTransformer;
