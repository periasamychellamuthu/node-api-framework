const SQLConnect = require('../Database/DBConnectionPool');
const sqlQueryBuilder = require('../Database/QueryBuilder/DBUtils');
const Entity = require('../API/Entity');

function DefaultEntityHandler() {
    this.APIRequest = null;
    this.entity = null;
    this.queryBuilder = sqlQueryBuilder;

    this.convertTOJSON = function (APIRequest) {
        if (APIRequest.dataObject instanceof Array) {
            APIRequest.result = [];
            for (var i = 0; i < APIRequest.dataObject.length; i++) {
                APIRequest.result.push(iterateFieldsAndGetResult(APIRequest.entity, {}, APIRequest, APIRequest.dataObject[i]));
            }
        } else {
            APIRequest.result = iterateFieldsAndGetResult(APIRequest.entity, {}, APIRequest);
        }
    }

    this.getInputValuesFromInputData = function (qb) {
        var raw_form_data = this.APIRequest.inputData.getEntityData() || {};
        var entityName = this.APIRequest.entity.getName();
        var form_data = raw_form_data[entityName] || {};
        
        var key_value = {};
        var fields = this.APIRequest.entity.getFields();
        Object.keys(fields).forEach((field, index) => {
            if (fields[field].isIdentifier) {
                return;
            }
            if (form_data[fields[field].name] !== undefined && form_data[fields[field].name] !== null) {
                key_value[getColumnNameFromRelationalMapping(fields[field].relationMapping)] = form_data[fields[field].name];
            }
        });
        return key_value;
    }

    this.executeResult = function (APIRequest, err) {
        var APIResult = {};
        var result = APIRequest.result;
        if (!err) {
            // Apply standard envelope defined in knowledge base
            APIResult["response_status"] = { status: 200, message: "Operation successful" };
            APIResult[APIRequest.entity.pluralName || `${APIRequest.entity.getName()}s`] = result;
        } else {
            APIResult["response_status"] = { status: 500, message: "Operation failed" };
            APIResult["error"] = err;
        }
        APIRequest.result = APIResult;
    }

    this.getSelectQueryWithoutSelectColumns = function () {
        var IdentifierField = this.entity.getIdentifierField();
        this.queryBuilder.addFromTableInQuery({ query: this.APIRequest.queryObject, table: this.entity.getTableName() });
        this.joinAllTablesOfEntity();
    }

    this.addTableAndCriteriaBasedOnNavigationInfo = function () {
        this.navigationInfo = this.APIRequest.navigationInfo;
        if (this.navigationInfo) {
            var refField = this.navigationInfo.getRefField();
            if (!refField.isAllowedValuesField()) {
                var parentEntity = this.navigationInfo.getParentEntity();
                this.queryBuilder.join(Object.assign(applyParentCriteria(this.entity, parentEntity, null, parentEntity.getId()), { query: this.APIRequest.queryObject }));
            }
        }
    }

    this.addEntityIntoQuery = function (options) {
        var entity = (options && options.entity) ? options.entity : this.entity;
        if (!(options && options.isFromNavigationInfo)) {
            this.queryBuilder.addFromTableInQuery({ query: this.APIRequest.queryObject, table: entity.getTableName() });
        }
        var IdentifierField = entity.getIdentifierField();
        var tableName = IdentifierField.getTableName();
        var columnName = IdentifierField.getColumnName();
        var criteria = {};
        if (entity.getId()) {
            criteria[tableName + '.' + columnName] = entity.getId();
        }
        this.joinAllTablesOfEntity({ entity: entity });
        if (Object.keys(criteria).length) {
            // this.APIRequest.queryObject.where(criteria);
            this.queryBuilder.setCriteria({ query: this.APIRequest.queryObject, criteria: criteria });
        }
    }

    this.addEntityIdCriteriaIntoQuery = function (options) {
        var criteria = getEntityIdCriteria(this.entity, this.entity.getId());
        if (criteria != null) {
            this.queryBuilder.setCriteria({ query: this.APIRequest.queryObject, criteria: criteria });
        }
    }

    this.joinAllTablesOfEntity = function (options) {
        var joinCriteria = null;
        var entity = (options && options.entity) ? options.entity : this.entity;
        Object.keys(entity.tablesForGetOperation).forEach((element, index) => {
            joinCriteria = entity.tablesForGetOperation[element];
            if (joinCriteria) {
                this.APIRequest.queryObject.join(element, joinCriteria);
                joinCriteria = null;
            }
        });
    }

    this.getCallback = function (results) {
        if (!results) {
            this.executeResult(this.APIRequest, "Database error or empty results");
            return this.APIRequest.response.status(500).send(this.APIRequest.result);
        }
        this.APIRequest.dataObject = results;
        this.convertTOJSON(this.APIRequest);
        this.executeResult(this.APIRequest);
        this.APIRequest.response.send(this.APIRequest.result);
    }

    this.getListCallback = function (result) {
        if (!result || !result[0]) {
            this.executeResult(this.APIRequest, "Database error or empty list results");
            return this.APIRequest.response.status(500).send(this.APIRequest.result);
        }
        this.APIRequest.dataObject = result[0];
        this.convertTOJSON(this.APIRequest);
        this.executeResult(this.APIRequest);
        this.APIRequest.response.send(this.APIRequest.result);
    }

    this.getSelectQueryForEntityGet = function (options) {
        this.addEntityIntoQuery();
    }
}

var getValueFromRelationMapping = function (dataObject, mapping) {
    var mappings = mapping.split('.');
    return dataObject[mappings[0]][mappings[1]];
}

var getColumnNameFromRelationalMapping = function (mapping) {
    return mapping.split('.')[1];
}

var getTablename = function (request) {
    return request.entity.getTableName();
}

var applyParentCriteria = function (currentEntity, referrringEntity, currentEntityId, referrringEntityId) {
    var parentTable = referrringEntity.getIdentifierField().getTableName();
    var parentField = referrringEntity.getFieldByName(currentEntity.getName() + "s");
    var criteria = {};
    if (referrringEntityId) {
        var referringEntityIdentifierColumnName = referrringEntity.getIdentifierField().getColumnName();
        criteria.criteria = {};
        criteria.criteria[referringEntityIdentifierColumnName] = referrringEntityId;
    }
    return Object.assign({ table: parentTable, joinCriteria: parentField.foreignKeyMapping }, criteria);
}

var getEntityIdCriteria = function (entity, entityId) {
    var criteria = null;
    if (entityId) {
        criteria = {};
        criteria[getColumnNameFromRelationalMapping(entity.getIdentifierField().relationMapping)] = entityId;
    }
    return criteria;
}

// used for post and put operation.
var iterateFieldsAndGetResult = function (entity, entityResult, APIRequest, dataObject) {
    var fields = entity.getFields();
    Object.keys(fields).forEach((field) => {
        if (fields[field].refEntity) {
            entityResult[fields[field].refEntity] = iterateFieldsAndGetResult(Entity.getEntityByName(fields[field].refEntity), {}, APIRequest, dataObject);
        } else {
            entityResult[fields[field].name] = getValueFromRelationMapping((dataObject) ? dataObject : APIRequest.dataObject, fields[field].relationMapping);
        }
    });
    return entityResult;
}

DefaultEntityHandler.prototype.get = function () {
    SQLConnect.runBuilder((qb) => {
        this.APIRequest.queryObject = qb;
        this.getSelectQueryForEntityGet();
        this.queryBuilder.queryGet(this.APIRequest.queryObject, this.APIRequest, (result) => {
            this.getCallback(result);
        });
    });
}

DefaultEntityHandler.prototype.getList = function () {
    SQLConnect.runBuilder((qb) => {
        this.APIRequest.queryObject = qb;
        this.getSelectQueryWithoutSelectColumns();
        this.addTableAndCriteriaBasedOnNavigationInfo();
        this.queryBuilder.queryGet(this.APIRequest.queryObject, this.APIRequest, (result) => {
            this.getCallback(result);
        });
    });
}
const DefaultEntityValidator = require('../Validation/DefaultEntityValidator');
const ListenerDispatcher = require('../Listener/ListenerDispatcher');
const SequenceGenerator = require('../Database/SequenceGenerator');

DefaultEntityHandler.prototype.post = async function () {
    try {
        await DefaultEntityValidator.validatePipeline(this.APIRequest);
        await ListenerDispatcher.dispatch('beforeCreate', this.APIRequest.entity, this.APIRequest.inputData, this.APIRequest.context.request);

        const tenantId = this.APIRequest.context.request.$credentials ? this.APIRequest.context.request.$credentials.tenantId : 'default_tenant';
        const tableName = getTablename(this.APIRequest);

        // Automatically inject Sequence Generator Mapping natively
        const generatedId = await SequenceGenerator.getNextId(tenantId, `${tableName}.id`);
        const insertData = this.getInputValuesFromInputData();
        insertData.id = generatedId; // Impose Algorithm assignment over default database bounds!

        SQLConnect.runBuilder(async qb => {
            try {
                await this.queryBuilder.queryInsert(qb, { table: tableName, data: insertData }, this.APIRequest);
                this.APIRequest.entityId = generatedId;
                this.get(this.APIRequest);
                await ListenerDispatcher.dispatch('afterCreate', this.APIRequest.entity, this.APIRequest.result, this.APIRequest.context.request);
            } catch (err) {
                this.APIRequest.response.status(400).json({ error: err.message });
            } finally {
                qb.release();
            }
        });
    } catch (err) {
        this.APIRequest.response.status(400).json({ error: err.message });
    }
}

DefaultEntityHandler.prototype.delete = function () {
    SQLConnect.runBuilder(async qb => {
        try {
            this.APIRequest.queryObject = qb;
            var results = {};
            if (this.APIRequest.entityId) {
                this.addEntityIdCriteriaIntoQuery();
                results = await this.queryBuilder.queryDelete(qb, { table: this.APIRequest.entity.getTableName() }, this.APIRequest);
            }
            this.APIRequest.result = results;
            this.executeResult(this.APIRequest);
            this.APIRequest.response.send(this.APIRequest.result);
        } catch (err) {
            this.APIRequest.response.status(400).json({ error: err.message });
        } finally {
            qb.release();
        }
    });
}

DefaultEntityHandler.prototype.update = async function () {
    try {
        await DefaultEntityValidator.validatePipeline(this.APIRequest);
        await ListenerDispatcher.dispatch('beforeUpdate', this.APIRequest.entity, this.APIRequest.inputData, this.APIRequest.context.request);

        SQLConnect.runBuilder((qb) => {
            this.APIRequest.queryObject = qb;
            this.queryBuilder.queryUpdate(qb, { table: getTablename(this.APIRequest), data: this.getInputValuesFromInputData(), criteria: { id: this.APIRequest.entityId } }, this.APIRequest, async (err, res) => {
                try {
                    if (err) throw err;
                    if (res && res.affectedRows) {
                        this.get(this.APIRequest);
                        await ListenerDispatcher.dispatch('afterUpdate', this.APIRequest.entity, this.APIRequest.result, this.APIRequest.context.request);
                    } else {
                        this.APIRequest.response.status(400).json({ response_status: { status: 400, message: "No rows edited" } });
                    }
                } catch (e) {
                    this.APIRequest.response.status(400).json({ error: e.message });
                } finally {
                    qb.release();
                }
            });
        });
    } catch (err) {
        this.APIRequest.response.status(400).json({ error: err.message });
    }
}

async function getEntityFromId(qb, results, request) {
    var values = {};
    values[getIdentifierColumnForEntity(request)] = results.insert_id;
    results = await qb.get_where(getTablename(request), values);
    return results;
}

DefaultEntityHandler.prototype.handleAPICall = async function (APIRequest) {
    this.APIRequest = APIRequest;
    this.entity = APIRequest.entity;

    var method = APIRequest.operation;
    if (method == 'GET') {
        if (APIRequest.entityId == null) {
            this.getList();
        } else {
            this.get();
        }
    }
    else if (method == 'PUT') {
        this.update();
    }
    else if (method == 'POST') {
        this.post();
    }
    else if (method == 'DELETE') {
        this.delete();
    }
}

module.exports = DefaultEntityHandler;