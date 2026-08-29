const path             = require('path');
const EntityConfigLoader = require('../Registry/EntityConfigLoader');
const Entity             = require('./Entity');

/**
 * EntityMetaDataHolder
 *
 * Boot-time registry. Reads all entity configs from EntityConfigLoader and builds
 * Entity runtime objects keyed by their URL path.
 *
 * Resolution rule for handler/validator (same convention for both):
 *   Default name (e.g. "DefaultEntityHandler") → framework default module
 *   Any other name  → src/<folder>/<name>.js, using the name exactly as
 *                     declared in the entity config (no case transformation)
 *   Not found       → falls back to the framework default
 *
 * Listeners use the same exact-name convention but are kept as name strings
 * (ListenerDispatcher requires them by name at dispatch time).
 *
 * relational_mapping:
 *   Uses the value from the entity config JSON field directly ("table.column").
 *   Does NOT auto-construct it from tableName.fieldName — entity configs own this mapping.
 */
function resolveModule(name, defaultName, defaultPath, folder) {
    if (!name || name === defaultName) {
        return require(defaultPath);
    }
    try {
        return require(path.join(process.cwd(), 'src', folder, name));
    } catch (e) {
        console.warn(`[EntityMetaDataHolder] ${folder} not found: ${name} → falling back to ${defaultName}`);
        return require(defaultPath);
    }
}

function metaDataHolder() {
    var entityMeta = {};

    this.addMetaDetails = function () {
        const entities = EntityConfigLoader.getAllEntities();
        entities.forEach(entityDef => {
            const handlerModule   = resolveModule(entityDef.handler, 'DefaultEntityHandler', '../Handler/DefaultEntityHandler', 'handler');
            const validatorModule = resolveModule(entityDef.validator, 'DefaultEntityValidator', '../Validation/DefaultEntityValidator', 'validator');

            const listeners = (entityDef.listeners || []).filter(name => {
                try {
                    require.resolve(path.join(process.cwd(), 'src', 'listener', name));
                    return true;
                } catch (e) {
                    console.warn(`[EntityMetaDataHolder] listener not found: ${name} → skipped`);
                    return false;
                }
            });

            const mappedJson = {
                name:       entityDef.entityName,
                pluralName: entityDef.pluralName,
                path:       entityDef.path,
                table_name: entityDef.tableName,
                handlers:   handlerModule,
                validator:  validatorModule,
                listeners:  listeners,
                operations: entityDef.operations || [],
                fields:     entityDef.fields
                    ? entityDef.fields.map(f => ({
                        name:               f.name,
                        is_identifier:      f.is_identifier || f.identifier || false,
                        // Use relational_mapping from entity config directly — do NOT
                        // auto-construct as tableName.fieldName (A-031 fix)
                        relational_mapping: f.relational_mapping || `${entityDef.tableName}.${f.name}`,
                        nullable:           f.nullable,
                        unique:             f.unique,
                        internal:           f.internal || false,
                        constraints:        f.constraints
                    }))
                    : []
            };

            entityMeta[mappedJson.path] = new Entity(mappedJson);
        });
    };

    this.addMetaDetails();

    this.get = function (name) {
        return entityMeta[name] || null;
    };

    this.getByPath = function (path) {
        if (path && path.indexOf('/') === -1) {
            path = '/' + path;
        }
        return Object.values(entityMeta).find(entity => entity.getPath() === path) || null;
    };
}

module.exports = new metaDataHolder();
