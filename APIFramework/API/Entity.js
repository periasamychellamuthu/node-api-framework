var Field = require('./EntityField');

function Entity(entityJSON) {
    this.id         = null;
    this.tableName  = entityJSON.table_name;
    this.name       = entityJSON.name;
    this.pluralName = entityJSON.pluralName  || null;
    this.path       = entityJSON.path        || null;
    this.handlers   = entityJSON.handlers;
    this.validator  = entityJSON.validator   || null;
    this.listeners  = entityJSON.listeners   || [];
    this.operations = entityJSON.operations  || [];
    this.fields     = {};
    this.tablesForGetOperation = [];

    this.getName = function () {
        return this.name;
    }

    this.getPluralName = function () {
        return this.pluralName || (this.name + 's');
    }

    this.getPath = function () {
        return this.path;
    }

    this.getTableName = function () {
        return this.tableName;
    }

    this.getValidator = function () {
        return this.validator;
    }

    this.getListeners = function () {
        return this.listeners;
    }

    this.getOperations = function () {
        return this.operations;
    }

    /**
     * Returns the operation config object for a given operation name,
     * e.g. getOperation('add') → { name:'add', method:'post', ... }
     */
    this.getOperation = function (operationName) {
        return this.operations.find(op => op.name === operationName) || null;
    }

    this.setId = function (id) {
        this.id = id;
    }

    this.getId = function () {
        return this.id;
    }

    this.getIdentifierField = function () {
        var identifierField = null;
        Object.keys(this.fields).forEach((field, index) => {
            if (this.fields[field].isIdentifier) {
                identifierField = this.fields[field];
            }
        });
        return identifierField;
    }

    this.getAllTablesForGetOperation = function () {
        return this.tablesForGetOperation;
    }

    this.getHandlerInstance = function () {
        if (!this.handlers) {
            // No handler resolved by EntityMetaDataHolder — use framework default
            this.handlers = require('../Handler/DefaultEntityHandler');
        }
        const handler = this.handlers;
        return new handler();
    }

    this.getFields = function () {
        return this.fields;
    }

    this.getRefEntityFields = function () {
        var refFields = [];
        Object.values(this.fields).forEach(field => {
            if (field.refFields) {
                refFields.push(field);
            }
        });
        return refFields;
    }

    this.getFieldByName = function (name) {
        return this.fields[name];
    }
    setFieldsForEntity(this, entityJSON);
}

function setFieldsForEntity(entity, entityJSON) {
    for (var i = 0; i < entityJSON.fields.length; i++) {
        var entityField = new Field(entityJSON.fields[i]);
        // var field = entity.fields[entityJSON.fields[i].name];
        if (!(entityField.getRefEntityName() != null && entityField.isCollection) && !(entityField.getTableName() in entity.tablesForGetOperation) && (entityField.getTableName() != entity.getTableName())) {
            entity.tablesForGetOperation[entityField.getTableName()] = entityField.foreignKeyMapping;
        }
        entity.fields[entityField.name] = entityField;
    }
}

module.exports = Entity;

module.exports.getEntityByPath = function (path) {
    var entityMetaData = require('./EntityMetaDataHolder');
    return entityMetaData.getByPath(path);
}

module.exports.getEntityByName = function (name) {
    const entityMetaData = require('./EntityMetaDataHolder');
    return entityMetaData.get(name);
}