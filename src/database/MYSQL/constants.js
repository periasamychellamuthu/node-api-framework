const fs = require('fs');
const path = require('path');

let productConfig = {};
try {
    const configPath = path.join(__dirname, '..', '..', '..', 'conf', 'product-config.json');
    if (fs.existsSync(configPath)) {
        const rawdata = fs.readFileSync(configPath);
        productConfig = JSON.parse(rawdata);
    }
} catch (e) {
    console.error(`[MySQL Constants] Failed to parse product-config.json: ${e.message}`);
}

const sqlConstants = {
    host: productConfig.host || "localhost",
    port: productConfig.port || "3306",
    database: productConfig.dataspace || "MarkManagementSystem",
    user: productConfig.user || "root",
    password: productConfig.password || ""
};

module.exports = sqlConstants;