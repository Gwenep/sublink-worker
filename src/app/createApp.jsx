/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from 'hono';
import { Layout } from '../components/Layout.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { Form } from '../components/Form.jsx';
import { Footer } from '../components/Footer.jsx';
import { UpdateChecker } from '../components/UpdateChecker.jsx';
import { SingboxConfigBuilder } from '../builders/SingboxConfigBuilder.js';
import { ClashConfigBuilder } from '../builders/ClashConfigBuilder.js';
import { SurgeConfigBuilder } from '../builders/SurgeConfigBuilder.js';
import { createTranslator, resolveLanguage } from '../i18n/index.js';
import yaml from 'js-yaml';
import { encodeBase64, tryDecodeSubscriptionLines } from '../utils.js';
import { APP_NAME, APP_SUBTITLE } from '../constants.js';
import { ShortLinkService } from '../services/shortLinkService.js';
import { ConfigStorageService, GLOBAL_CONFIG_KEYS } from '../services/configStorageService.js';
import { ServiceError, MissingDependencyError } from '../services/errors.js';
import { normalizeRuntime } from '../runtime/runtimeConfig.js';
import { PREDEFINED_RULE_SETS, CLASH_CONFIG, SURGE_CONFIG, SING_BOX_CONFIG, SING_BOX_CONFIG_V1_11, generateSubconverterConfig } from '../config/index.js';

const DEFAULT_USER_AGENT = 'curl/7.74.0';

export function createApp(bindings = {}) {
    const runtime = normalizeRuntime(bindings);
    const services = {
        shortLinks: runtime.kv ? new ShortLinkService(runtime.kv, { shortLinkTtlSeconds: runtime.config.shortLinkTtlSeconds }) : null,
        configStorage: runtime.kv ? new ConfigStorageService(runtime.kv, { configTtlSeconds: runtime.config.configTtlSeconds }) : null
    };

    const app = new Hono();

    app.use('*', async (c, next) => {
        const acceptLanguage = getRequestHeader(c.req, 'Accept-Language');
        const lang = c.req.query('lang') || acceptLanguage?.split(',')[0] || 'zh-CN';
        c.set('lang', lang);
        c.set('t', createTranslator(lang));
        await next();
    });

    app.get('/', (c) => {
        const t = c.get('t');
        const lang = resolveLanguage(c.get('lang'));
        const subtitle = APP_SUBTITLE[lang] || APP_SUBTITLE['zh-CN'];

        return c.html(
            <Layout title={t('pageTitle')} description={t('pageDescription')} keywords={t('pageKeywords')}>
                <div class="flex flex-col min-h-screen">
                    <Navbar />
                    <main class="flex-1">
                        <div class="container mx-auto px-4 py-8 pt-24">
                            <div class="max-w-4xl mx-auto">
                                <div class="text-center mb-12 pt-8">
                                    <h1 class="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white mb-4 tracking-tight">
                                        {APP_NAME}
                                    </h1>
                                    <p class="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
                                        {subtitle}
                                    </p>
                                </div>
                                <Form t={t} lang={lang} />
                            </div>
                        </div>
                    </main>
                    <Footer />
                    <UpdateChecker />
                </div>
            </Layout>
        );
    });

    app.get('/singbox', (c) => handleSingboxRequest(c, c.req.query(), services, runtime));
    app.get('/clash', (c) => handleClashRequest(c, c.req.query(), services, runtime));
    app.get('/surge', (c) => handleSurgeRequest(c, c.req.query(), services, runtime));

    app.get('/subconverter', (c) => {
        try {
            const rawSelectedRules = c.req.query('selectedRules');
            let selectedRules;

            if (!rawSelectedRules) {
                selectedRules = PREDEFINED_RULE_SETS.balanced;
            } else if (PREDEFINED_RULE_SETS[rawSelectedRules]) {
                selectedRules = PREDEFINED_RULE_SETS[rawSelectedRules];
            } else {
                try {
                    const parsed = JSON.parse(rawSelectedRules);
                    if (Array.isArray(parsed)) {
                        selectedRules = parsed;
                    } else {
                        return c.text('Invalid selectedRules: must be a preset name (minimal, balanced, comprehensive) or a JSON array', 400);
                    }
                } catch {
                    return c.text(`Invalid selectedRules: "${rawSelectedRules}" is not a valid preset name or JSON array. Valid presets: minimal, balanced, comprehensive`, 400);
                }
            }

            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const lang = c.get('lang');

            const config = generateSubconverterConfig({
                selectedRules,
                customRules,
                lang,
                includeAutoSelect,
                groupByCountry
            });

            return c.text(config, 200, {
                'Content-Type': 'text/plain; charset=utf-8'
            });
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/xray', (c) => handleXrayRequest(c, c.req.query(), services, runtime));

    app.get('/shorten-v2', async (c) => {
        try {
            const url = c.req.query('url');
            if (!url) {
                return c.text('Missing URL parameter', 400);
            }
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
            } catch {
                return c.text('Invalid URL parameter', 400);
            }
            const queryString = parsedUrl.search;

            const shortLinks = requireShortLinkService(services.shortLinks);
            const code = await shortLinks.createShortLink(queryString, c.req.query('shortCode'));
            return c.text(code);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    const SHORT_LINK_HANDLERS = {
        surge: handleSurgeRequest,
        singbox: handleSingboxRequest,
        clash: handleClashRequest,
        xray: handleXrayRequest,
    };

    const shortLinkHandler = (type) => async (c) => {
        try {
            const code = c.req.param('code');
            const shortLinks = requireShortLinkService(services.shortLinks);
            const queryString = await shortLinks.resolveShortCode(code);
            if (!queryString) return c.text('Short URL not found', 404);

            const params = Object.fromEntries(new URLSearchParams(queryString));

            let subscriptionUrl;
            if (type === 'surge') {
                const origin = new URL(c.req.url).origin;
                subscriptionUrl = `${origin}/surge?${queryString}`;
            }

            return SHORT_LINK_HANDLERS[type](c, params, services, runtime, { subscriptionUrl });
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    };

    app.get('/s/:code', shortLinkHandler('surge'));
    app.get('/b/:code', shortLinkHandler('singbox'));
    app.get('/c/:code', shortLinkHandler('clash'));
    app.get('/x/:code', shortLinkHandler('xray'));

    app.post('/config', async (c) => {
        try {
            const { type, content } = await c.req.json();
            const storage = requireConfigStorage(services.configStorage);
            const configId = await storage.saveConfig(type, content);
            return c.text(configId);
        } catch (error) {
            if (error instanceof SyntaxError) {
                return c.text(`Invalid format: ${error.message}`, 400);
            }
            return handleError(c, error, runtime.logger);
        }
    });

    // Single shared ("default") config: POST saves the global copy under a
    // fixed key, GET reads it back. Every visitor sees the same default.
    app.post('/config/global', async (c) => {
        try {
            const { type, content } = await c.req.json();
            if (!GLOBAL_CONFIG_KEYS[type]) {
                return c.text('Invalid type', 400);
            }
            const storage = requireConfigStorage(services.configStorage);
            const key = await storage.saveConfig(type, content, { key: GLOBAL_CONFIG_KEYS[type] });
            return c.text(key);
        } catch (error) {
            if (error instanceof SyntaxError) {
                return c.text(`Invalid format: ${error.message}`, 400);
            }
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/config/global', async (c) => {
        try {
            const type = c.req.query('type');
            if (!GLOBAL_CONFIG_KEYS[type]) {
                return c.text('Invalid type', 400);
            }
            const storage = requireConfigStorage(services.configStorage);
            const stored = await storage.getGlobalConfig(type);
            if (!stored) {
                return c.json({ found: false });
            }
            return c.json({ found: true, content: stored });
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/resolve', async (c) => {
        try {
            const shortUrl = c.req.query('url');
            const t = c.get('t');
            if (!shortUrl) return c.text(t('missingUrl'), 400);

            let urlObj;
            try {
                urlObj = new URL(shortUrl);
            } catch {
                return c.text(t('invalidShortUrl'), 400);
            }
            const pathParts = urlObj.pathname.split('/');
            if (pathParts.length < 3) return c.text(t('invalidShortUrl'), 400);

            const prefix = pathParts[1];
            const shortCode = pathParts[2];
            if (!['b', 'c', 'x', 's'].includes(prefix)) return c.text(t('invalidShortUrl'), 400);

            const shortLinks = requireShortLinkService(services.shortLinks);
            const originalParam = await shortLinks.resolveShortCode(shortCode);
            if (!originalParam) return c.text(t('shortUrlNotFound'), 404);

            const mapping = { b: 'singbox', c: 'clash', x: 'xray', s: 'surge' };
            const originalUrl = `${urlObj.origin}/${mapping[prefix]}${originalParam}`;
            return c.json({ originalUrl });
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/favicon.ico', async (c) => {
        if (!runtime.assetFetcher) {
            return c.notFound();
        }
        try {
            return await runtime.assetFetcher(c.req.raw);
        } catch (error) {
            runtime.logger.warn('Asset fetch failed', error);
            return c.notFound();
        }
    });

    return app;
}

export function parseSelectedRules(raw) {
    if (!raw) return [];

    // 首先检查是否是预设名称 (minimal, balanced, comprehensive)
    // 这确保向后兼容主分支的 API 行为
    if (typeof raw === 'string' && PREDEFINED_RULE_SETS[raw]) {
        return PREDEFINED_RULE_SETS[raw];
    }

    // 尝试解析为 JSON 数组
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        // 解析失败，回退到 minimal 预设
        console.warn(`Failed to parse selectedRules: ${raw}, falling back to minimal`);
        return PREDEFINED_RULE_SETS.minimal;
    }
}

function parseJsonArray(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Resolve custom rules from either the inline `customRules` JSON param or,
 * when absent, from a saved KV blob referenced by `customRulesId`. The inline
 * param wins so old links keep working; KV is a fallback for shorter URLs.
 * When neither is present, fall back to the shared global default rules so a
 * "Save as Default" makes every generated link use them automatically.
 */
async function resolveCustomRules(params, services) {
    const inline = parseJsonArray(params.customRules);
    if (inline.length > 0) {
        return inline;
    }
    if (params.customRulesId) {
        const storage = requireConfigStorage(services.configStorage);
        const stored = await storage.getConfigById(params.customRulesId);
        if (Array.isArray(stored)) {
            return stored;
        }
    }
    return resolveGlobalRules(services);
}

/**
 * Read the shared global default custom rules (global_custom_rules key). Used
 * as a fallback when a request carries no inline rules and no saved rules id.
 */
async function resolveGlobalRules(services) {
    if (!services.configStorage) return [];
    try {
        const stored = await services.configStorage.getGlobalConfig('customRules');
        return Array.isArray(stored) ? stored : [];
    } catch {
        return [];
    }
}

/**
 * Resolve the base config for a conversion: an explicit per-link configId wins;
 * otherwise fall back to the shared global default base config when its type
 * matches the requested client type, so a "Save as Default" on the UI applies
 * to every generated link without requiring a configId param.
 */
async function resolveBaseConfig(params, services, requestedType, builtInFallback) {
    if (params.configId) {
        const storage = requireConfigStorage(services.configStorage);
        const stored = await storage.getConfigById(params.configId);
        if (stored) return stored;
    }
    if (services.configStorage) {
        try {
            const global = await services.configStorage.getGlobalConfig('baseConfig');
            if (global && global.type === requestedType) {
                return parseSerializedConfig(global.content, requestedType);
            }
        } catch {
            // Ignore and fall through to the built-in default.
        }
    }
    return builtInFallback;
}

/**
 * Deserialize a stored base config to the object shape the builders expect.
 * Clash content is saved as YAML text and needs to be loaded; sing-box/surge
 * are already JSON objects.
 */
function parseSerializedConfig(content, requestedType) {
    if (typeof content !== 'string') {
        return typeof content === 'object' ? content : null;
    }
    if (requestedType === 'clash') {
        return yaml.load(content);
    }
    return JSON.parse(content);
}

function parseBooleanFlag(value) {
    return value === 'true' || value === true;
}

function parseSemverLike(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const match = trimmed.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: match[3] ? Number(match[3]) : 0
    };
}

function isSingboxLegacyConfig(version) {
    if (!version || Number.isNaN(version.major) || Number.isNaN(version.minor)) {
        return false;
    }
    if (version.major !== 1) {
        return version.major < 1;
    }
    return version.minor < 12;
}

// 1.14 swaps rule-set download_detour for http_client, which older clients
// reject as an unknown field, so it needs its own config tier.
function isSingboxModernConfig(version) {
    if (!version || Number.isNaN(version.major) || Number.isNaN(version.minor)) {
        return false;
    }
    if (version.major !== 1) {
        return version.major > 1;
    }
    return version.minor >= 14;
}

function resolveSingboxConfigTier(version) {
    if (isSingboxLegacyConfig(version)) return '1.11';
    return isSingboxModernConfig(version) ? '1.14' : '1.12';
}

function resolveSingboxConfigVersion(requestedVersion, userAgent) {
    const normalizedRequested = typeof requestedVersion === 'string' ? requestedVersion.trim().toLowerCase() : '';
    if (normalizedRequested && normalizedRequested !== 'auto') {
        if (normalizedRequested === 'legacy') return '1.11';
        if (normalizedRequested === 'latest') return '1.14';
        const parsed = parseSemverLike(normalizedRequested);
        if (parsed) {
            return resolveSingboxConfigTier(parsed);
        }
    }

    if (typeof userAgent === 'string' && userAgent) {
        const uaMatch = userAgent.match(/sing-box\/(\d+\.\d+(?:\.\d+)?)/i) || userAgent.match(/sing-box\s+(\d+\.\d+(?:\.\d+)?)/i);
        const versionString = uaMatch?.[1];
        const parsed = versionString ? parseSemverLike(versionString) : null;
        if (parsed) {
            return resolveSingboxConfigTier(parsed);
        }
    }

    return '1.12';
}

function getRequestHeader(request, name) {
    if (!request || !name) {
        return undefined;
    }

    try {
        const value = request.header(name);
        if (value !== undefined) {
            return value;
        }
    } catch {
        // Fallback if HonoRequest.header cannot read from the raw request.
    }

    const headers = request.raw?.headers;
    if (!headers) {
        return undefined;
    }

    if (typeof headers.get === 'function') {
        return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
    }

    if (typeof headers === 'object') {
        const lowerName = name.toLowerCase();
        const headerValue = headers[lowerName] ?? headers[name];
        if (Array.isArray(headerValue)) {
            return headerValue[0];
        }
        return headerValue;
    }

    return undefined;
}

function requireShortLinkService(service) {
    if (!service) {
        throw new MissingDependencyError('Short link functionality is unavailable');
    }
    return service;
}

function requireConfigStorage(service) {
    if (!service) {
        throw new MissingDependencyError('Config storage functionality is unavailable');
    }
    return service;
}

function handleError(c, error, logger) {
    if (error instanceof ServiceError) {
        return c.text(error.message, error.status);
    }
    logger.error?.('Unhandled error', error);
    return c.text(`Error: ${error.message}`, 500);
}

/**
 * Shared sing-box config handler used by both the /singbox route and the
 * /b/:code short link. `params` is a plain query params object (route side
 * passes c.req.query(), short link side parses the stored queryString), so a
 * client only ever touches the short code instead of a multi-KB redirect URL.
 */
async function handleSingboxRequest(c, params, services, runtime) {
    try {
        const config = params.config;
        if (!config) {
            return c.text('Missing config parameter', 400);
        }

        const selectedRules = parseSelectedRules(params.selectedRules);
        const customRules = await resolveCustomRules(params, services);
        const ua = params.ua || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
        const groupByCountry = parseBooleanFlag(params.group_by_country);
        const includeAutoSelect = params.include_auto_select !== 'false';
        const enableClashUI = parseBooleanFlag(params.enable_clash_ui);
        const externalController = params.external_controller;
        const externalUiDownloadUrl = params.external_ui_download_url;
        // Short link requests have no query string, so the stored lang param
        // would be lost to the middleware; prefer the explicit param.
        const lang = params.lang || c.get('lang');

        const requestedSingboxVersion = params.singbox_version || params.sb_version || params.sb_ver;
        const requestUserAgent = getRequestHeader(c.req, 'User-Agent');
        const singboxConfigVersion = resolveSingboxConfigVersion(requestedSingboxVersion, requestUserAgent);

        const builtIn = singboxConfigVersion === '1.11' ? SING_BOX_CONFIG_V1_11 : SING_BOX_CONFIG;
        const baseConfig = await resolveBaseConfig(params, services, 'singbox', builtIn);

        const builder = new SingboxConfigBuilder(
            config,
            selectedRules,
            customRules,
            baseConfig,
            lang,
            ua,
            groupByCountry,
            enableClashUI,
            externalController,
            externalUiDownloadUrl,
            singboxConfigVersion,
            includeAutoSelect
        );
        await builder.build();
        const userinfo = builder.getSubscriptionUserinfo();
        if (userinfo) {
            c.header('subscription-userinfo', userinfo);
        }
        return c.json(builder.config);
    } catch (error) {
        return handleError(c, error, runtime.logger);
    }
}

/**
 * Shared Clash config handler used by both the /clash route and the
 * /c/:code short link.
 */
async function handleClashRequest(c, params, services, runtime) {
    try {
        const config = params.config;
        if (!config) {
            return c.text('Missing config parameter', 400);
        }

        const selectedRules = parseSelectedRules(params.selectedRules);
        const customRules = await resolveCustomRules(params, services);
        const ua = params.ua || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
        const groupByCountry = parseBooleanFlag(params.group_by_country);
        const includeAutoSelect = params.include_auto_select !== 'false';
        const enableClashUI = parseBooleanFlag(params.enable_clash_ui);
        const externalController = params.external_controller;
        const externalUiDownloadUrl = params.external_ui_download_url;
        const lang = params.lang || c.get('lang');

        const baseConfig = await resolveBaseConfig(params, services, 'clash', CLASH_CONFIG);

        const builder = new ClashConfigBuilder(
            config,
            selectedRules,
            customRules,
            baseConfig,
            lang,
            ua,
            groupByCountry,
            enableClashUI,
            externalController,
            externalUiDownloadUrl,
            includeAutoSelect
        );
        await builder.build();
        const userinfo = builder.getSubscriptionUserinfo();
        const headers = { 'Content-Type': 'text/yaml; charset=utf-8' };
        if (userinfo) {
            headers['subscription-userinfo'] = userinfo;
        }
        return c.text(builder.formatConfig(), 200, headers);
    } catch (error) {
        return handleError(c, error, runtime.logger);
    }
}

/**
 * Shared Surge config handler used by both the /surge route and the
 * /s/:code short link. For short links the dispatcher rebuilds the canonical
 * long /surge URL as the MANAGED-CONFIG target so Surge's periodic refresh
 * keeps hitting a live endpoint.
 */
async function handleSurgeRequest(c, params, services, runtime, options = {}) {
    try {
        const config = params.config;
        if (!config) {
            return c.text('Missing config parameter', 400);
        }

        const selectedRules = parseSelectedRules(params.selectedRules);
        const customRules = await resolveCustomRules(params, services);
        const ua = params.ua || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
        const groupByCountry = parseBooleanFlag(params.group_by_country);
        const includeAutoSelect = params.include_auto_select !== 'false';
        const lang = params.lang || c.get('lang');

        const baseConfig = await resolveBaseConfig(params, services, 'surge', SURGE_CONFIG);

        const builder = new SurgeConfigBuilder(
            config,
            selectedRules,
            customRules,
            baseConfig,
            lang,
            ua,
            groupByCountry,
            includeAutoSelect
        );
        builder.setSubscriptionUrl(options?.subscriptionUrl ?? c.req.url);
        await builder.build();

        const userinfo = builder.getSubscriptionUserinfo();
        if (userinfo) {
            c.header('subscription-userinfo', userinfo);
        }
        return c.text(builder.formatConfig());
    } catch (error) {
        return handleError(c, error, runtime.logger);
    }
}

/**
 * Shared Xray config handler used by both the /xray route and the
 * /x/:code short link. Unlike the builders it fetches each HTTP(S) config
 * line directly and base64-encodes the resulting node list.
 */
async function handleXrayRequest(c, params, services, runtime) {
    const inputString = params.config;
    if (!inputString) {
        return c.text('Missing config parameter', 400);
    }

    const proxylist = inputString.split('\n');
    const finalProxyList = [];
    let subscriptionUserinfo;
    const userAgent = params.ua || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
    const headers = { 'User-Agent': userAgent };

    for (const proxy of proxylist) {
        const trimmedProxy = proxy.trim();
        if (!trimmedProxy) continue;

        if (trimmedProxy.startsWith('http://') || trimmedProxy.startsWith('https://')) {
            try {
                const response = await fetch(trimmedProxy, { method: 'GET', headers });
                const fetchedUserinfo = response.headers.get('subscription-userinfo');
                if (fetchedUserinfo && subscriptionUserinfo === undefined) {
                    subscriptionUserinfo = fetchedUserinfo;
                }
                const text = await response.text();
                let processed = tryDecodeSubscriptionLines(text, { decodeUriComponent: true });
                if (!Array.isArray(processed)) processed = [processed];
                finalProxyList.push(...processed.filter(item => typeof item === 'string' && item.trim() !== ''));
            } catch (e) {
                runtime.logger.warn('Failed to fetch the proxy', e);
            }
        } else {
            let processed = tryDecodeSubscriptionLines(trimmedProxy);
            if (!Array.isArray(processed)) processed = [processed];
            finalProxyList.push(...processed.filter(item => typeof item === 'string' && item.trim() !== ''));
        }
    }

    const finalString = finalProxyList.join('\n');
    if (!finalString) {
        return c.text('Missing config parameter', 400);
    }

    const responseHeaders = {};
    if (subscriptionUserinfo) {
        responseHeaders['subscription-userinfo'] = subscriptionUserinfo;
    }

    return c.text(encodeBase64(finalString), 200, responseHeaders);
}
