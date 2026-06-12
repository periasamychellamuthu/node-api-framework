const AbstractEntityHandler = require('./AbstractEntityHandler');
const DefaultEntityValidator = require('../Validation/DefaultEntityValidator');

/**
 * The core framework implementation of the CRUD routines.
 * Wraps operations with EntityListeners and history logging rules.
 */
class PreDefaultEntityHandler extends AbstractEntityHandler {
    constructor() {
        super();
    }

    async add(request) {
        // 1. Invoke XML Validator Pipeline
        await DefaultEntityValidator.validatePipeline(request);

        // 2. Invoke pre-listeners
    }

    async edit(request) {
        // 1. Invoke XML Validator Pipeline
        await DefaultEntityValidator.validatePipeline(request);
    }

    async getList(request) {
        throw new Error("PreDefaultEntityHandler.getList not implemented fully yet.");
    }

    async getEntity(request) {
        throw new Error("PreDefaultEntityHandler.getEntity not implemented fully yet.");
    }

    async delete(request) {
        throw new Error("PreDefaultEntityHandler.delete not implemented fully yet.");
    }

    async handleOperation(request) {
        throw new Error("PreDefaultEntityHandler.handleOperation not implemented fully yet.");
    }

    async getAllowedValues(request) {
        throw new Error("PreDefaultEntityHandler.getAllowedValues not implemented fully yet.");
    }
}

module.exports = PreDefaultEntityHandler;
