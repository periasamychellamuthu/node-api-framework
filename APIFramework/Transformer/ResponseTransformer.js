class ResponseTransformer {
    static transform(entity, operation, resultData) {
        const safeData = this.stripInternalFields(entity, resultData);
        return {
            response_status: { status: 'success', message: 'Operation successful' },
            [entity.getPluralName()]: safeData
        };
    }

    static stripInternalFields(entity, payload) {
        if (!payload) return payload;

        const fieldsMap      = entity.getFields ? entity.getFields() : {};
        const internalFields = Object.values(fieldsMap)
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
