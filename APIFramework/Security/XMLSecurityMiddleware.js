const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

class XMLSecurityMiddleware {
    constructor() {
        this.allowedRoutes = [];
        this.securityTemplates = null;
        this.regexMap = {};
        this.ready = false;
        this.init();
    }

    async init() {
        const securityDir = path.join(process.cwd(), 'security-config');
        const apiPath = path.join(securityDir, 'security-api.xml');
        const templatePath = path.join(securityDir, 'security-template-v1.xml');
        const regexPath = path.join(securityDir, 'security-regex-v1.xml');

        const parser = new xml2js.Parser();

        try {
            // 1. Load security-api.xml (URL + method + roles + param templates)
            if (fs.existsSync(apiPath)) {
                const apiXml = await parser.parseStringPromise(fs.readFileSync(apiPath, 'utf-8'));
                const urls = apiXml.security.url;
                const urlArray = Array.isArray(urls) ? urls : [urls];

                this.allowedRoutes = urlArray.map(u => {
                    const regexPath = u.$.path.replace(/:[^\s/]+/g, '([^/]+)');
                    return {
                        pathRegex: new RegExp(`^${regexPath}$`),
                        originalPath: u.$.path,
                        method: u.$.method.toUpperCase(),
                        roles: u.$.roles ? u.$.roles.split(',').map(r => r.trim()) : [],
                        params: u.param ? (Array.isArray(u.param) ? u.param : [u.param]) : []
                    };
                });
                console.log(`[XMLSecurity] Cached ${this.allowedRoutes.length} allowed endpoints from security-api.xml`);
            }

            // 2. Load security-template-v1.xml (JSON templates for input validation)
            if (fs.existsSync(templatePath)) {
                const templateXml = await parser.parseStringPromise(fs.readFileSync(templatePath, 'utf-8'));
                this.securityTemplates = templateXml;
            }

            // 3. Load security-regex-v1.xml (regex pattern definitions)
            if (fs.existsSync(regexPath)) {
                const regexXml = await parser.parseStringPromise(fs.readFileSync(regexPath, 'utf-8'));
                if (regexXml && regexXml.security && regexXml.security.regexes && regexXml.security.regexes[0].regex) {
                    for (let r of regexXml.security.regexes[0].regex) {
                        this.regexMap[r.$.name] = r.$.value;
                    }
                }
                console.log(`[XMLSecurity] Loaded ${Object.keys(this.regexMap).length} regex patterns`);
            }

            this.ready = true;
            console.log('[XMLSecurity] Security layer fully initialized.');
        } catch (err) {
            console.error(`[XMLSecurity] Initialization error: ${err.message}`);
        }
    }

    /**
     * Recursively validate data against template keys.
     * Handles nested JSONObject wrappers and leaf-level regex/max-len checks.
     */
    _validateTemplateKeys(keys, data) {
        for (let keyDef of keys) {
            const fieldName = keyDef.$.name;
            const regexName = keyDef.$.regex;
            const isObject = keyDef.$.type === 'JSONObject';

            if (data[fieldName] !== undefined && data[fieldName] !== null) {
                if (isObject) {
                    // Entity wrapper key — must be an object, recurse into children
                    if (typeof data[fieldName] !== 'object' || Array.isArray(data[fieldName])) {
                        throw new Error(`Security Exception: '${fieldName}' must be a JSON Object`);
                    }
                    // Resolve child keys — either from a referenced template or inline keys
                    let childKeys = null;
                    if (keyDef.$.template) {
                        const refTemplate = this._findTemplate(keyDef.$.template);
                        if (refTemplate && refTemplate.key) {
                            childKeys = Array.isArray(refTemplate.key) ? refTemplate.key : [refTemplate.key];
                        }
                    } else if (keyDef.key) {
                        childKeys = Array.isArray(keyDef.key) ? keyDef.key : [keyDef.key];
                    }
                    if (childKeys) {
                        this._validateTemplateKeys(childKeys, data[fieldName]);
                    }
                } else {
                    // Leaf field — validate max-len and regex
                    const val = data[fieldName].toString();

                    const maxLen = parseInt(keyDef.$['max-len']);
                    if (!isNaN(maxLen) && val.length > maxLen) {
                        throw new Error(`Security Exception: Field '${fieldName}' exceeds max length of ${maxLen}`);
                    }

                    if (regexName && this.regexMap[regexName]) {
                        const rx = new RegExp(this.regexMap[regexName]);
                        if (!rx.test(val)) {
                            throw new Error(`Security Exception: Invalid pattern in field '${fieldName}'`);
                        }
                    }
                }
            }
        }
    }

    /**
     * Find the template by name from security-template-v1.xml
     */
    _findTemplate(templateName) {
        if (!this.securityTemplates || !this.securityTemplates.security || !this.securityTemplates.security.jsontemplate) {
            return null;
        }
        const templates = this.securityTemplates.security.jsontemplate;
        const arr = Array.isArray(templates) ? templates : [templates];
        return arr.find(t => t.$.name === templateName) || null;
    }

    /**
     * Express middleware — the single security gate for all requests.
     * Layer 1: URL + Method whitelisting
     * Layer 2: Role-based access control
     * Layer 3: input_data template validation (regex, max-len, structure)
     */
    validate(req, res, next) {
        if (req.path === '/favicon.ico') return next();

        // Wait for async init if not ready yet
        if (!this.ready) {
            return setTimeout(() => this.validate(req, res, next), 50);
        }

        const method = req.method.toUpperCase();
        const reqPath = req.path;

        // --- Layer 1: URL Whitelisting ---
        const matchedRoute = this.allowedRoutes.find(r => r.method === method && r.pathRegex.test(reqPath));

        if (!matchedRoute) {
            console.warn(`[XMLSecurity] URL Blocked - Not whitelisted: ${method} ${reqPath}`);
            return res.status(403).json({
                response_status: { status_code: 4003, status: 'failed', message: 'Access Denied: URL not whitelisted' }
            });
        }

        // --- Layer 2: Role Check ---
        const userRoles = req.$credentials ? req.$credentials.roles : ['Guest'];
        const hasRole = userRoles.some(role => matchedRoute.roles.includes(role));

        if (!hasRole) {
            console.warn(`[XMLSecurity] Role Blocked - Required [${matchedRoute.roles}], Had [${userRoles}]: ${method} ${reqPath}`);
            return res.status(403).json({
                response_status: { status_code: 4003, status: 'failed', message: 'Access Denied: Insufficient permissions' }
            });
        }

        // --- Layer 3: input_data Template Validation ---
        try {
            for (let param of matchedRoute.params) {
                if (param.$.name === 'input_data' && param.$.template) {
                    const templateName = param.$.template;
                    const templateObj = this._findTemplate(templateName);

                    if (templateObj && templateObj.key) {
                        // Extract the input_data from the request body
                        const inputData = req.body && req.body.input_data
                            ? (typeof req.body.input_data === 'string' ? JSON.parse(req.body.input_data) : req.body.input_data)
                            : null;

                        if (!inputData) {
                            throw new Error('Security Exception: Missing required input_data parameter');
                        }

                        const keys = Array.isArray(templateObj.key) ? templateObj.key : [templateObj.key];
                        this._validateTemplateKeys(keys, inputData);
                    }
                }
            }
        } catch (err) {
            console.warn(`[XMLSecurity] Template validation failed: ${err.message}`);
            return res.status(400).json({
                response_status: { status_code: 4000, status: 'failed', message: err.message }
            });
        }

        console.log(`[XMLSecurity] Passed: ${method} ${reqPath}`);
        next();
    }
}

module.exports = new XMLSecurityMiddleware();

