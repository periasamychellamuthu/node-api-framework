class InputData {
    constructor(requestBody, queryParams) {
        this.rawBody = requestBody || {};
        this.queryParams = queryParams || {};
        
        this.entityData = null;
        this.listInfo = null;
        this.search = null;
        this.aggregateInfo = null;
        
        this.parse();
    }

    parse() {
        // Look for the standard input_data structure
        if (this.rawBody.input_data) {
            let inputData;
            try {
                inputData = typeof this.rawBody.input_data === 'string' 
                            ? JSON.parse(this.rawBody.input_data) 
                            : this.rawBody.input_data;
            } catch (e) {
                throw new Error("Invalid JSON in input_data");
            }
            
            // Assign raw input directly retaining the entity wrappers as declared in the Security architecture
            this.entityData = inputData;
            
            this.listInfo = inputData.list_info || null;
            this.search = inputData.search || null;
            this.aggregateInfo = inputData.aggregate_info || null;
        } else {
            // Fallback for direct json POST requests without the input_data wrapper
            this.entityData = this.rawBody;
        }

        // Also merge any list_info from query params if passed directly
        if (this.queryParams.list_info) {
            try {
                this.listInfo = JSON.parse(this.queryParams.list_info);
            } catch (e) {
                this.listInfo = this.queryParams.list_info;
            }
        }
    }

    getEntityData() {
        return this.entityData;
    }

    getListInfo() {
        return this.listInfo;
    }

    getSearch() {
        return this.search;
    }
}

module.exports = InputData;
