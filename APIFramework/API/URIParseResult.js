class URIParseResult {
    constructor(urlPath) {
        this.originalPath = urlPath;
        this.module = null;
        this.entityId = null;
        this.subEntities = [];
        this.parse(urlPath);
    }

    parse(urlPath) {
        // e.g. /api/v3/users/123/tasks
        const parts = urlPath.split('/').filter(Boolean);
        
        let startIndex = 0;
        if (parts[0] === 'api' && parts[1] === 'v3') {
            startIndex = 2; // skip /api/v3
        } else if (parts[0] === 'api' && parts[1] === 'v1') {
            startIndex = 2; // skip /api/v1 backwards compatibility
        }

        if (startIndex < parts.length) {
            this.module = parts[startIndex];
        }
        
        if (startIndex + 1 < parts.length) {
            this.entityId = parts[startIndex + 1];
        }

        if (startIndex + 2 < parts.length) {
            this.subEntities = parts.slice(startIndex + 2);
        }
    }

    getModule() {
        return this.module;
    }

    getEntityId() {
        return this.entityId;
    }

    getSubEntities() {
        return this.subEntities;
    }
}

module.exports = URIParseResult;
