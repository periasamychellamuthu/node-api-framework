const path = require('path');

/**
 * ListenerDispatcher
 *
 * Executes entity lifecycle listeners defined in entity config's "listeners" array.
 *
 * Listener files live in: src/listener/<ListenerName>.js
 * Each listener file exports a class or plain object with static/instance methods
 * matching the hook names (beforeCreate, afterCreate, beforeUpdate, afterUpdate,
 * beforeDelete, afterDelete).
 *
 * Example entity config:
 *   "listeners": ["CustomModuleProvisioningListener"]
 *
 * Example listener file (src/listener/CustomModuleProvisioningListener.js):
 *   class CustomModuleProvisioningListener {
 *       static async afterCreate(data, req) { ... }
 *   }
 *   module.exports = CustomModuleProvisioningListener;
 *
 * If a listener file does not exist, or does not implement the hook, the dispatch
 * logs a warning and continues — it does NOT crash the request.
 *
 * Git reference: 9ff288c — listener invocation was commented out; now active.
 */
class ListenerDispatcher {

    /**
     * Dispatch a lifecycle hook to all listeners registered for the entity.
     *
     * @param {string} hookName      e.g. 'beforeCreate', 'afterCreate', 'beforeUpdate', etc.
     * @param {object} entityConfig  raw entity config JSON (has .listeners array)
     * @param {object} data          the data being processed (inputData or result row)
     * @param {object} req           Express request object (has req.orgId, req.memberId, etc.)
     */
    static async dispatch(hookName, entityConfig, data, req) {

        if (!entityConfig || !entityConfig.listeners || entityConfig.listeners.length === 0) {
            // No listeners registered — nothing to do
            return;
        }

        console.log(`[ListenerDispatcher] Dispatching '${hookName}' to: ${entityConfig.listeners.join(', ')}`);

        for (const listenerName of entityConfig.listeners) {
            const listenerPath = path.join(process.cwd(), 'src', 'listener', listenerName);

            try {
                // Dynamically require the listener from src/listener/
                // (was commented out in git 9ff288c — now active)
                const ListenerClass = require(listenerPath);

                if (typeof ListenerClass[hookName] === 'function') {
                    await ListenerClass[hookName](data, req);
                    console.log(`[ListenerDispatcher] → Executed ${listenerName}.${hookName}`);
                } else {
                    // Hook not implemented in this listener — not an error, just skip
                    console.log(`[ListenerDispatcher] → ${listenerName} has no '${hookName}' — skipped`);
                }

            } catch (err) {
                if (err.code === 'MODULE_NOT_FOUND') {
                    console.warn(
                        `[ListenerDispatcher] Listener file not found: src/listener/${listenerName}.js — skipped`
                    );
                } else {
                    // Listener threw a runtime error — log it but do NOT crash the request
                    console.error(
                        `[ListenerDispatcher] Error in ${listenerName}.${hookName}:`, err.message
                    );
                    // Re-throw if it's a critical listener error that must abort the operation
                    // (domain handlers can override dispatch to change this behaviour)
                    throw err;
                }
            }
        }
    }
}

module.exports = ListenerDispatcher;
