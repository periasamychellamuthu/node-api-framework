const ApiUtils = require("../../APIFramework/Utils/APIUtils");

const DefaultEntityHandler = ApiUtils.getDefaultEntityHandler();

class UserEntityHandler extends DefaultEntityHandler {
    constructor() {
        super();
    }

    getEntityName() {
        return this.entityName;
    }
}

module.exports = UserEntityHandler;