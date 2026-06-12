/**
 * Handles the Dual sync/async event system.
 * - Sync via EntityListenerUtil beforeDB/afterDB
 * - QEvent async operations (Mocked for Quetta Protobuf)
 */
class EntityListenerUtil {
    
    constructor() {
        this.listeners = []; // Holds registered {Module}Listener implementations
    }

    registerListener(listener) {
        this.listeners.push(listener);
    }

    async beforeDB(request, dbObject) {
        console.log(`[EntityListenerUtil] Executing beforeDB() sync listeners for ${request.operation} on Entity: ${request.entity.getName()}`);
        for (const listener of this.listeners) {
            if (typeof listener.beforeDB === 'function') {
                await listener.beforeDB(request, dbObject);
            }
        }
    }

    async afterDB(request, dbObject, result) {
        console.log(`[EntityListenerUtil] Executing afterDB() sync listeners post-transaction.`);
        for (const listener of this.listeners) {
            if (typeof listener.afterDB === 'function') {
                await listener.afterDB(request, dbObject, result);
            }
        }

        // QEvent async trigger (Protobuf)
        this.triggerQEvent(request.operation, result);
    }

    async triggerQEvent(type, result) {
        // Mocking the protobuf Quetta async emission block
        console.log(`[QEvent] Firing asynchronous Protobuf event definition for operation: ${type}`);
    }
}

module.exports = new EntityListenerUtil();
