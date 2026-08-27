const PreDefaultEntityHandler = require('../../APIFramework/Handler/PreDefaultEntityHandler');

class UserEntityHandler extends PreDefaultEntityHandler {
    constructor() {
        super();
    }

    getEntityName() {
        return 'user';
    }
}

module.exports = UserEntityHandler;
