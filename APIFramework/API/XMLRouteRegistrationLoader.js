const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const router = require('../DefaultRouterHandler');

class XMLRouteRegistrationLoader {
    async registerRoutes(app) {
        console.log(`[XMLRouteLoader] Parsing security-api.xml to dynamically mount native Express routes...`);
        const xmlPath = path.join(__dirname, '..', '..', 'security-config', 'security-api.xml');
        
        if (!fs.existsSync(xmlPath)) {
            console.error(`[XMLRouteLoader] CRITICAL ERROR: security-api.xml not found!`);
            return;
        }

        const xmlData = fs.readFileSync(xmlPath, 'utf-8');
        const parser = new xml2js.Parser();
        const parsed = await parser.parseStringPromise(xmlData);

        if (parsed.security && parsed.security.url) {
            const urls = Array.isArray(parsed.security.url) ? parsed.security.url : [parsed.security.url];
            
            urls.forEach(urlNode => {
                const routePath = urlNode.$.path;
                const method = urlNode.$.method.toLowerCase();
                
                if (typeof app[method] === 'function') {
                    app[method](routePath, router.handleRequest);
                    console.log(`[XMLRouteLoader] Mounted route natively: ${method.toUpperCase()} ${routePath}`);
                } else {
                    console.warn(`[XMLRouteLoader] Invalid method ${method} for path ${routePath}`);
                }
            });
        }
        console.log(`[XMLRouteLoader] Route registration complete!`);
    }
}

module.exports = new XMLRouteRegistrationLoader();
