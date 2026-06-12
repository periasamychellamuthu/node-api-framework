const EntityConfigLoader = require('../Configuration/EntityConfigLoader');
const Entity = require('./Entity');

function metaDataHolder() {
    var entityMeta = {};

    this.addMetaDetails = function () {
        const entities = EntityConfigLoader.getAllEntities();
        entities.forEach(entityDef => {
            let handlerModule = null;
            if (entityDef.handler) {
                try {
                    let handlerPathFallback = `../../src/Handler/${entityDef.handler.charAt(0).toLowerCase() + entityDef.handler.slice(1)}`;
                    handlerModule = require(handlerPathFallback);
                } catch (e) { }
            }

            let mappedJson = {
                name: entityDef.entityName,
                path: entityDef.path,
                table_name: entityDef.tableName,
                handlers: handlerModule,
                fields: entityDef.fields ? entityDef.fields.map(f => ({
                    name: f.name,
                    is_identifier: f.identifier || false,
                    relational_mapping: `${entityDef.tableName}.${f.name}`,
                    nullable: f.nullable,
                    unique: f.unique,
                    constraints: f.constraints
                })) : []
            };
            entityMeta[mappedJson.path] = new Entity(mappedJson);
        });
    }

    this.addMetaDetails();

    this.get = function (path) {
        if (path && path.indexOf('/') === -1) {
            path = '/' + path;
        }
        return entityMeta[path];
    }
}

module.exports = new metaDataHolder();