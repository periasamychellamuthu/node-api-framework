const ApiUtils = require("../../APIFramework/Utils/APIUtils");

const DefaultEntityHandler = ApiUtils.getDefaultEntityHandler();

function UserEntityHandler() {
    DefaultEntityHandler.call(this);
};
UserEntityHandler.prototype = Object.create(DefaultEntityHandler.prototype);
UserEntityHandler.prototype.constructor = UserEntityHandler;
UserEntityHandler.prototype.getEntityName = function(){
    return this.entityName;
}

module.exports = UserEntityHandler;