import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { decodeBase64 } from '../src/utils.js';

const createTestApp = (overrides = {}) => {
    const runtime = {
        kv: overrides.kv ?? new MemoryKVAdapter(),
        assetFetcher: overrides.assetFetcher ?? null,
        logger: console,
        config: {
            configTtlSeconds: 60,
            shortLinkTtlSeconds: null,
            ...(overrides.config || {})
        }
    };
    return createApp(runtime);
};

describe('Worker', () => {
    it('GET / returns HTML', async () => {
        const app = createTestApp();
        const res = await app.request('http://localhost/');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        const text = await res.text();
        expect(text).toContain('Sublink Worker');
    });

    it('GET /singbox returns JSON', async () => {
        const app = createTestApp();
        const config = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';
        const res = await app.request(`http://localhost/singbox?config=${encodeURIComponent(config)}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        const json = await res.json();
        expect(json).toHaveProperty('outbounds');
    });

    it('GET /singbox returns legacy config for sing-box 1.11 UA', async () => {
        const app = createTestApp();
        const config = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';
        const res = await app.request(`http://localhost/singbox?config=${encodeURIComponent(config)}`, {
            headers: {
                'User-Agent': 'SFI/1.12.2 (Build 2; sing-box 1.11.4; language zh_CN)'
            }
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json?.dns?.servers?.[0]).toHaveProperty('address');
        expect(json?.dns?.servers?.[0]).not.toHaveProperty('type');
        expect(json?.route).not.toHaveProperty('default_domain_resolver');
    });

    it('GET /singbox returns 1.12+ config for sing-box 1.12 UA', async () => {
        const app = createTestApp();
        const config = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';
        const res = await app.request(`http://localhost/singbox?config=${encodeURIComponent(config)}`, {
            headers: {
                'User-Agent': 'SFA/1.12.12 (587; sing-box 1.12.12; language zh_Hans_CN)'
            }
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json?.dns?.servers?.[0]).toHaveProperty('type');
        expect(json?.dns?.servers?.[0]).not.toHaveProperty('address');
        expect(json?.route).toHaveProperty('default_domain_resolver', 'dns_resolver');
    });

    it('GET /clash returns YAML', async () => {
        const app = createTestApp();
        const config = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';
        const res = await app.request(`http://localhost/clash?config=${encodeURIComponent(config)}`);
        expect(res.status).toBe(200);
        // Clash builder returns text/yaml
        expect(res.headers.get('content-type')).toContain('text/yaml');
        const text = await res.text();
        expect(text).toContain('proxies:');
    });

    it('GET /clash rejects empty url-test proxy groups with a diagnostic error', async () => {
        const app = createTestApp();
        const config = `
proxies:
  - name: Node-A
    type: ss
    server: a.example.com
    port: 443
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: Empty Test Group
    type: url-test
    proxies: []
`;
        const res = await app.request(`http://localhost/clash?config=${encodeURIComponent(config)}`);

        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain('Invalid proxy group "Empty Test Group"');
        expect(text).toContain('requires at least one proxy or provider reference');
    });

    it('GET /shorten-v2 returns short code', async () => {
        const url = 'http://example.com';
        const kvMock = {
            put: vi.fn(async () => {}),
            get: vi.fn(async () => null),
            delete: vi.fn(async () => {})
        };
        const app = createTestApp({ kv: kvMock });
        const res = await app.request(`http://localhost/shorten-v2?url=${encodeURIComponent(url)}`);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toBeTruthy();
        expect(kvMock.put).toHaveBeenCalled();
    });

    // Short links now return config content directly instead of redirecting,
    // so clients (e.g. Clash Verge) never have to follow a multi-KB URL.
    describe('short links return config directly', () => {
        const VMESS_CONFIG = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';

        it('GET /c/:code returns clash YAML with 200 instead of a redirect', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            // shorten-v2 stores parsedUrl.search, which includes the leading '?'
            const queryString = `?config=${encodeURIComponent(VMESS_CONFIG)}`;
            await kv.put('abc123', queryString);

            const res = await app.request('http://localhost/c/abc123');
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('text/yaml');
            expect(res.headers.get('location')).toBeNull();
            const text = await res.text();
            expect(text).toContain('proxies:');
        });

        it('GET /b/:code returns singbox JSON', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            // shorten-v2 stores parsedUrl.search, which includes the leading '?'
            const queryString = `?config=${encodeURIComponent(VMESS_CONFIG)}`;
            await kv.put('abc123', queryString);

            const res = await app.request('http://localhost/b/abc123');
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('application/json');
            const json = await res.json();
            expect(json).toHaveProperty('outbounds');
        });

        it('GET /s/:code returns surge config text', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            // shorten-v2 stores parsedUrl.search, which includes the leading '?'
            const queryString = `?config=${encodeURIComponent(VMESS_CONFIG)}`;
            await kv.put('abc123', queryString);

            const res = await app.request('http://localhost/s/abc123');
            expect(res.status).toBe(200);
            const text = await res.text();
            expect(text).toContain('[Proxy]');
            // Surge managed config should point at the canonical long URL
            expect(text).toContain('#!MANAGED-CONFIG http://localhost/surge?');
        });

        it('GET /x/:code returns base64-encoded proxy list', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            // shorten-v2 stores parsedUrl.search, which includes the leading '?'
            const queryString = `?config=${encodeURIComponent(VMESS_CONFIG)}`;
            await kv.put('abc123', queryString);

            const res = await app.request('http://localhost/x/abc123');
            expect(res.status).toBe(200);
            const body = await res.text();
            const decoded = decodeBase64(body);
            expect(decoded).toContain('vmess://');
        });

        it('GET /c/:code returns 404 for an unknown short code', async () => {
            const app = createTestApp();
            const res = await app.request('http://localhost/c/notexist');
            expect(res.status).toBe(404);
            const text = await res.text();
            expect(text).toContain('Short URL not found');
        });

        it('short link honors stored lang param when no query string', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            // shorten-v2 stores parsedUrl.search, which includes the leading '?'
            const queryString = `?config=${encodeURIComponent(VMESS_CONFIG)}&lang=en`;
            await kv.put('abc123', queryString);

            const res = await app.request('http://localhost/s/abc123');
            expect(res.status).toBe(200);
            const text = await res.text();
            // English group names appear when lang=en is honored
            expect(text).toContain('Node Select');
        });

        it('short link honors stored configId base config', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            const configId = 'clash_test123';
            await kv.put(configId, JSON.stringify({
                'mixed-port': 7890,
                'allow-lan': true
            }));
            // shorten-v2 stores parsedUrl.search, which includes the leading '?'
            const queryString = `?config=${encodeURIComponent(VMESS_CONFIG)}&configId=${configId}`;
            await kv.put('abc123', queryString);

            const res = await app.request('http://localhost/c/abc123');
            expect(res.status).toBe(200);
            const text = await res.text();
            expect(text).toContain('mixed-port: 7890');
        });

        it('GET /resolve still returns the original long URL', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            // shorten-v2 stores parsedUrl.search, which includes the leading '?'
            const queryString = `?config=${encodeURIComponent(VMESS_CONFIG)}`;
            await kv.put('abc123', queryString);

            const res = await app.request('http://localhost/resolve?url=' + encodeURIComponent('http://localhost/c/abc123'));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.originalUrl).toContain('/clash?');
            expect(data.originalUrl).toContain(encodeURIComponent(VMESS_CONFIG));
        });
    });

    describe('custom rules KV persistence', () => {
        it('saves customRules via /config and consumes via customRulesId', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            const config = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';

            // Save custom rules to KV
            const rules = [{ name: 'LAN', src_ip_cidr: '192.168.1.13/32' }];
            const saveRes = await app.request('http://localhost/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'customRules', content: rules })
            });
            const id = (await saveRes.text()).trim();
            expect(saveRes.status).toBe(200);
            expect(id).toContain('customRules_');

            // Consume via customRulesId instead of inline JSON
            const res = await app.request(
                `http://localhost/clash?config=${encodeURIComponent(config)}&customRulesId=${encodeURIComponent(id)}`
            );
            expect(res.status).toBe(200);
            const text = await res.text();
            expect(text).toContain('LAN');
        });

        it('falls back to inline customRules when no customRulesId present', async () => {
            const app = createTestApp();
            const config = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';
            const rules = JSON.stringify([{ name: 'Custom', domain_suffix: 'example.com' }]);
            const res = await app.request(`http://localhost/clash?config=${encodeURIComponent(config)}&customRules=${encodeURIComponent(rules)}`);
            expect(res.status).toBe(200);
            const text = await res.text();
            expect(text).toContain('Custom');
        });
    });

    describe('global default config', () => {
        it('saves and reads customRules under the fixed global key', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            const rules = [{ name: 'LAN', src_ip_cidr: '192.168.1.13/32' }];
            const save = await app.request('http://localhost/config/global', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'customRules', content: rules })
            });
            expect(save.status).toBe(200);
            expect((await save.text()).trim()).toBe('global_custom_rules');

            const get = await app.request('http://localhost/config/global?type=customRules');
            const data = await get.json();
            expect(data.found).toBe(true);
            expect(data.content).toEqual(rules);
        });

        it('saves and reads baseConfig with type wrapping', async () => {
            const kv = new MemoryKVAdapter();
            const app = createTestApp({ kv });
            const body = { type: 'baseConfig', content: { type: 'clash', content: 'port: 7890\n' } };
            const save = await app.request('http://localhost/config/global', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            expect(save.status).toBe(200);

            const get = await app.request('http://localhost/config/global?type=baseConfig');
            const data = await get.json();
            expect(data.found).toBe(true);
            expect(data.content.type).toBe('clash');
            expect(data.content.content).toContain('port: 7890');
        });

        it('returns found:false when nothing saved yet', async () => {
            const app = createTestApp();
            const get = await app.request('http://localhost/config/global?type=customRules');
            const data = await get.json();
            expect(data.found).toBe(false);
        });

        it('rejects an unknown global type', async () => {
            const app = createTestApp();
            const get = await app.request('http://localhost/config/global?type=nope');
            expect(get.status).toBe(400);
        });
    });
});
