class InputDataMiddleware {
    /**
     * Extracts and validates the `input_data` structure from request representations.
     */
    static extractInputData(req, res, next) {
        if (!req._entityConfig) return next();

        // Parse input_data if it exists (usually POST/PUT or complex GET params)
        let inputData = {};

        if (req.method === 'POST' || req.method === 'PUT') {
            if (req.body && req.body.input_data) {
                inputData = typeof req.body.input_data === 'string' 
                            ? JSON.parse(req.body.input_data) 
                            : req.body.input_data;
            } else {
                // If the root body IS the payload and we want to wrap it
                inputData = req.body || {};
            }
        } else if (req.method === 'GET' && req.query.input_data) {
            try {
                inputData = JSON.parse(req.query.input_data);
            } catch (e) {
                return res.status(400).json({ error: "Invalid JSON in input_data query parameter." });
            }
        }

        req._inputData = inputData;
        console.log(`[InputDataMiddleware] Extracted input_data for ${req._entityConfig.entityName}`);
        
        next();
    }
}

module.exports = InputDataMiddleware;
