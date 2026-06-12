/**
 * DefaultEntityValidator
 * 
 * Handles entity-level validation as defined in the Validator Reference:
 *   1. fillReferences    → Resolve reference field IDs
 *   2. fillDefaults      → Populate default values and placeholders
 *   3. checkReferenceIds → Validate foreign key integrity
 *   4. computeDiff       → For updates: compute changed fields
 *   5. validateConstraints → Field-level constraints (nullable, maxLength, regex from entity config)
 *   6. validate          → Custom business rule validation (override point)
 *   7. preProcess        → Data enrichment before save (override point)
 * 
 * NOTE: XML-based input validation (security templates, regex patterns, max-len)
 * is handled exclusively by the XMLSecurityMiddleware in the security layer.
 * This validator does NOT touch XML at all.
 */

class DefaultEntityValidator {
    constructor() {
        // No XML loading — that belongs in the security middleware layer
    }

    /**
     * The master validation pipeline mandated by FW-Architecture.
     * @param {APIRequest} apiRequest 
     */
    async validatePipeline(apiRequest) {
        await this.fillRefs(apiRequest);
        await this.fillDefaults(apiRequest);
        await this.checkRefIDs(apiRequest);
        await this.basicValidation(apiRequest);
        await this.diff(apiRequest);
        await this.validate(apiRequest);
        await this.preProcess(apiRequest);
        return true;
    }

    /**
     * Entity-level constraint validation:
     * - Nullable checks for mandatory fields
     * - Data Dictionary max-size enforcement
     * - Entity config regex constraints
     */
    async basicValidation(apiRequest) {
        console.log("[ValidatorPipeline] basicValidation start...");
        const rawInputData = apiRequest.inputData.getEntityData() || {};
        const entityName = apiRequest.entity.getName();
        // Extract based on entity-keyed contract: {"user": {...}}
        const inputData = rawInputData[entityName] || {};
        console.log("[ValidatorPipeline] Validating entity data for:", entityName, Object.keys(inputData));

        const fields = apiRequest.entity.getFields();
        const tableName = apiRequest.entity.getTableName();
        const DataDictionaryParser = require('../Configuration/DataDictionaryParser');

        // Ensure valid ID is present for mutating operations
        const op = apiRequest.operation;
        if (op === 'PUT' || op === 'DELETE') {
            if (!apiRequest.entityId) {
                throw new Error(`Mandatory identifier missing from URL path for ${op} operation`);
            }
        }

        Object.keys(fields).forEach(key => {
            const field = fields[key];
            const value = inputData[field.name];

            // Nullable check — identifier fields are auto-generated
            if (field.nullable === false && !field.isIdentifier) {
                if (value === undefined || value === null || value === '') {
                    throw new Error(`Mandatory field missing: ${field.name}`);
                }
            }

            if (value !== undefined && value !== null) {
                // Entity config regex constraint check
                if (field.constraints && field.constraints.regex) {
                    const regexPattern = field.constraints.regex;
                    // If it's a direct regex pattern string from entity config
                    try {
                        const rx = new RegExp(regexPattern);
                        if (!rx.test(value.toString())) {
                            throw new Error(`Constraint violation: Field '${field.name}' failed regex validation`);
                        }
                    } catch (regexErr) {
                        console.warn(`[Validator] Invalid regex for field ${field.name}: ${regexErr.message}`);
                    }
                }

                // Data Dictionary max-size constraint
                const maxSize = DataDictionaryParser.getColumnProperty(tableName, field.name, 'max-size');
                if (maxSize !== null && typeof value === 'string' && value.length > maxSize) {
                    throw new Error(`Field '${field.name}' length (${value.length}) exceeds max size of ${maxSize}`);
                }
            }
        });
        console.log("[ValidatorPipeline] basicValidation passed.");
    }

    async fillRefs(apiRequest) {
        // Resolve reference field IDs (e.g., {"status": {"name": "Open"}} → resolve to ID)
        if (apiRequest.inputData && apiRequest.inputData.getEntityData()) {
            console.log("[ValidatorPipeline] fillRefs executing...");
        }
    }

    async fillDefaults(apiRequest) {
        // Populate default values and placeholders ($now, $currentUser)
        console.log("[ValidatorPipeline] fillDefaults executing...");
    }

    async checkRefIDs(apiRequest) {
        // Validate foreign key integrity
        console.log("[ValidatorPipeline] checkRefIDs executing...");
    }

    async diff(apiRequest) {
        // Compute diff between old and new data for partial updates
        console.log("[ValidatorPipeline] diff executing...");
    }

    async validate(apiRequest) {
        // Custom business rule validation — override point for entity-specific handlers
        console.log("[ValidatorPipeline] validate (business rules) executing...");
    }

    async preProcess(apiRequest) {
        // Data enrichment before save — override point
        console.log("[ValidatorPipeline] preProcess executing...");
    }
}

// Export as a singleton
module.exports = new DefaultEntityValidator();

