class ValidatorEngine {
    /**
     * Pre-processes the input data, applying default values and resolving placeholders before validation.
     */
    static preProcess(entityConfig, input, req) {
        const DBUtils = require('../Database/QueryBuilder/DBUtils');
        console.log(`[ValidatorEngine] Running pre-processing for ${entityConfig.entityName}`);
        
        entityConfig.fields.forEach(field => {
            // Apply default value if missing
            if (input[field.name] === undefined && field.defaultValue !== undefined) {
                input[field.name] = field.defaultValue;
            }

            // If the field now has a string value, attempt placeholder resolution (e.g., $now, $currentUser)
            if (typeof input[field.name] === 'string' && input[field.name].startsWith('$')) {
                input[field.name] = DBUtils.resolvePlaceholders(input[field.name], req);
            }
        });

        return input;
    }

    /**
     * Validates the payload against constraints and definitions defined in the entity configuration.
     */
    static async validate(entityConfig, input, operation, req) {
        // Run Pre-processing first
        if (operation === 'add' || operation === 'edit') {
            this.preProcess(entityConfig, input, req);
        }

        console.log(`[ValidatorEngine] Running validation for ${entityConfig.entityName}:${operation}`);
        const errors = [];

        if (operation === 'add' || operation === 'edit') {
            // Check mandatory fields
            entityConfig.fields.forEach(field => {
                if (!field.nullable && input[field.name] === undefined && operation === 'add') {
                    errors.push({ field: field.name, issue: 'Field is mandatory but missing.' });
                }
                
                if (input[field.name] !== undefined) {
                    // Primitive type checks
                    if (field.type === 'string' && typeof input[field.name] !== 'string') {
                        errors.push({ field: field.name, issue: 'Expected type string.' });
                    }
                    if (field.type === 'number' && typeof input[field.name] !== 'number') {
                        errors.push({ field: field.name, issue: 'Expected type number.' });
                    }

                    // Granular Constraint checks
                    if (field.constraints) {
                        if (field.constraints.regex && typeof input[field.name] === 'string') {
                            const regex = new RegExp(field.constraints.regex);
                            if (!regex.test(input[field.name])) {
                                errors.push({ field: field.name, issue: `Failed regex validation constraint: ${field.constraints.regex}` });
                            }
                        }
                    }
                }
            });

            // If tupleProperties exists (Versatile feature), validate limits
            if (entityConfig.tupleProperties && operation === 'add') {
                console.log(`[ValidatorEngine] Found tupleProperties, simulating limit evaluation.`);
                // In a real DB scenario, we would count here.
            }
        }

        if (errors.length > 0) {
            throw { status: 400, errors };
        }

        return true;
    }
}

module.exports = ValidatorEngine;
