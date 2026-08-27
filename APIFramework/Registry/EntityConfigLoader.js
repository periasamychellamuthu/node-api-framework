const fs = require('fs');
const path = require('path');

class EntityConfigLoader {
    constructor(configDir) {
        this.configDir = configDir || path.join(process.cwd(), 'src', 'entities');
        this.entities = new Map();
    }

    loadAll() {
        if (!fs.existsSync(this.configDir)) {
            console.warn(`[EntityConfigLoader] Config directory does not exist: ${this.configDir}`);
            return;
        }

        const files = fs.readdirSync(this.configDir);
        files.forEach(file => {
            if (file.endsWith('.json')) {
                const filePath = path.join(this.configDir, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const config = JSON.parse(content);
                    if (config.entityName) {
                        this.entities.set(config.entityName, config);
                        console.log(`[EntityConfigLoader] Loaded entity: ${config.entityName}`);
                    } else {
                        console.warn(`[EntityConfigLoader] Skipping invalid config without entityName: ${file}`);
                    }
                } catch (err) {
                    console.error(`[EntityConfigLoader] Error parsing config file: ${file}`, err);
                }
            }
        });
    }

    getEntity(entityName) {
        return this.entities.get(entityName);
    }

    getAllEntities() {
        return Array.from(this.entities.values());
    }
}

module.exports = new EntityConfigLoader();
