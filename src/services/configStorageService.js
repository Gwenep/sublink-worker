import yaml from 'js-yaml';
import { generateWebPath } from '../utils.js';
import { InvalidPayloadError, MissingDependencyError } from './errors.js';

// Fixed KV keys for the single shared ("default") config that every visitor
// sees. There is no login system, so "default" is a single global copy.
export const GLOBAL_CONFIG_KEYS = {
    customRules: 'global_custom_rules',
    baseConfig: 'global_base_config'
};

export class ConfigStorageService {
    constructor(kv, options = {}) {
        this.kv = kv;
        this.options = options;
    }

    ensureKv() {
        if (!this.kv) {
            throw new MissingDependencyError('Config storage requires a KV store');
        }
        return this.kv;
    }

    async getConfigById(configId) {
        const kv = this.ensureKv();
        const stored = await kv.get(configId);
        if (!stored) return null;
        try {
            return JSON.parse(stored);
        } catch {
            throw new InvalidPayloadError('Stored config is not valid JSON');
        }
    }

    async saveConfig(type, content, { key } = {}) {
        if (!type) {
            throw new InvalidPayloadError('Missing config type');
        }

        const kv = this.ensureKv();
        const configId = key || `${type}_${generateWebPath(8)}`;
        const configString = this.serializeConfig(type, content);

        // Validate string is JSON before storing
        JSON.parse(configString);

        const ttlSeconds = this.options.configTtlSeconds;
        const putOptions = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
        await kv.put(configId, configString, putOptions);
        return configId;
    }

    /**
     * Read the single shared ("default") config for a type. Returns null when
     * nothing has been saved yet.
     */
    async getGlobalConfig(type) {
        const kv = this.ensureKv();
        const key = GLOBAL_CONFIG_KEYS[type];
        if (!key) return null;
        const stored = await kv.get(key);
        if (!stored) return null;
        return JSON.parse(stored);
    }

    serializeConfig(type, content) {
        if (type === 'clash') {
            if (typeof content === 'string' && (content.trim().startsWith('-') || content.includes(':'))) {
                const yamlConfig = yaml.load(content);
                return JSON.stringify(yamlConfig);
            }
            return typeof content === 'object' ? JSON.stringify(content) : content;
        }

        if (typeof content === 'object') {
            return JSON.stringify(content);
        }
        if (typeof content === 'string') {
            return content;
        }
        throw new InvalidPayloadError('Unsupported config content type');
    }
}
