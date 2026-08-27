class RBACMiddleware {
    /**
     * Enforces Role-Based Access Control using the Entity route definition.
     */
    static enforcePermissions(req, res, next) {
        // The router adds req._entityConfig and req._operation.
        // If they don't exist, this is a path not managed by the dynamic router, pass it through.
        if (!req._entityConfig || !req._operation) {
            return next();
        }

        const entity = req._entityConfig;
        const operationName = req._operation;
        const userRoles = req.userRoles || ['Guest'];

        // Determine if there are specific roles for this operation
        let requiredRoles = null;

        // Check in operations array
        if (entity.operations) {
            const opConfig = entity.operations.find(op => op.name === operationName);
            if (opConfig && opConfig.roles) {
                requiredRoles = opConfig.roles;
            }
        }

        // If no explicit roles defined for the operation, allow by default (or we could default to deny)
        // For Versatile, unless specified, it might be allowed, but usually entity config specifies it.
        if (!requiredRoles) {
            console.log(`[RBACMiddleware] No specific roles required for ${entity.entityName}:${operationName}`);
            return next();
        }

        // Check if user has at least one of the required roles
        const hasPermission = userRoles.some(role => requiredRoles.includes(role));

        if (hasPermission) {
            console.log(`[RBACMiddleware] Authorization granted for ${entity.entityName}:${operationName}`);
            next();
        } else {
            console.warn(`[RBACMiddleware] Access Denied: User lacking required roles [${requiredRoles.join(',')}]`);
            return res.status(403).json({ error: "Access Denied: Insufficient permissions." });
        }
    }
}

module.exports = RBACMiddleware;
