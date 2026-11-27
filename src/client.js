import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    BASE_URL,
    HEADERS,
    DEFAULT_DELAY_MS,
    TIMEOUT_MS,
    MAX_RETRIES
} from './config.js';

const execFileAsync = promisify(execFile);
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

export class HttpClient {
    constructor(options = {}) {
        this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
        this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
        this.maxRetries = options.maxRetries ?? MAX_RETRIES;
        this.headers = { ...HEADERS, ...(options.headers || {}) };
        this.lastRequestTime = 0;
    }

    async throttle() {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.delayMs) {
            await new Promise(resolve => setTimeout(resolve, this.delayMs - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * Executes HTTP GET using system curl with auto-retries and fallback to native fetch.
     */
    async get(url, customHeaders = {}, retries = this.maxRetries) {
        const timeoutSec = Math.max(5, Math.ceil(this.timeoutMs / 1000));
        let lastError = null;

        const effectiveHeaders = { ...this.headers, ...customHeaders };
        const headerArgs = [];
        for (const [k, v] of Object.entries(effectiveHeaders)) {
            if (k.toLowerCase() !== 'user-agent' && v !== undefined && v !== null && v !== '') {
                headerArgs.push('-H', `${k}: ${v}`);
            }
        }

        const curlArgs = [
            '-sL',
            '--compressed',
            '--max-time', String(timeoutSec),
            '-w', '\n__HTTP_STATUS__:%{http_code}',
            '-A', effectiveHeaders['User-Agent'] || this.headers['User-Agent'],
            ...headerArgs,
            url
        ];

        for (let attempt = 1; attempt <= retries; attempt++) {
            await this.throttle();

            try {
                const { stdout } = await execFileAsync(CURL_BIN, curlArgs, {
                    maxBuffer: 40 * 1024 * 1024,
                    windowsHide: true
                });

                if (stdout) {
                    const statusIdx = stdout.lastIndexOf('__HTTP_STATUS__:');
                    let statusCode = 200;
                    let body = stdout;
                    if (statusIdx !== -1) {
                        body = stdout.slice(0, statusIdx);
                        const statusStr = stdout.slice(statusIdx + '__HTTP_STATUS__:'.length).trim();
                        statusCode = parseInt(statusStr, 10) || 0;
                    }

                    if (statusCode === 404) return null;

                    if (statusCode === 429) {
                        const waitMs = 3000 * attempt;
                        console.warn(`[Client] Rate limited (429) on ${url}. Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }

                    if (statusCode >= 500) {
                        const waitMs = 2000 * attempt;
                        console.warn(`[Client] Server error (${statusCode}) on ${url}. Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }

                    if (statusCode >= 200 && statusCode < 300) {
                        return body;
                    }

                    lastError = new Error(`HTTP Error ${statusCode}: ${body.slice(0, 100)}`);
                }
            } catch (curlErr) {
                lastError = curlErr;
                // Fallback to native fetch
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
                    const res = await fetch(url, {
                        headers: effectiveHeaders,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    if (res.status === 404) return null;
                    if (res.ok) {
                        return await res.text();
                    }
                    lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
                } catch (fetchErr) {
                    lastError = fetchErr;
                }
            }

            if (attempt === retries) {
                throw new Error(`Failed to GET ${url} after ${retries} attempts: ${lastError?.message || 'Unknown error'}`);
            }
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }

        return null;
    }

    /**
     * Fetches catalog page HTML (e.g. / or /page/2/).
     */
    async getCatalogPage(page = 1) {
        const url = page === 1 ? `${BASE_URL}/` : `${BASE_URL}/page/${page}/`;
        return await this.get(url, {
            'Referer': BASE_URL
        });
    }

    /**
     * Fetches video detail page HTML.
     */
    async getVideoDetail(urlOrPath) {
        let fullUrl = urlOrPath;
        if (!fullUrl.startsWith('http')) {
            fullUrl = `${BASE_URL}/${String(urlOrPath).replace(/^\/+/, '')}`;
        }
        return await this.get(fullUrl, {
            'Referer': BASE_URL
        });
    }

    /**
     * Resolves a JAV.guru searcho URL to the final embed/streaming URL.
     */
    async resolveSearchoEmbed(searchoUrl, referer = BASE_URL) {
        try {
            const pageHtml = await this.get(searchoUrl, { 'Referer': referer });
            if (!pageHtml) return null;

            // 1. Resolve token from page
            const cidMatch = pageHtml.match(/cid:\s*'([a-z0-9]+)'/);
            const rtypeMatch = pageHtml.match(/rtype:\s*'([a-z]+)'/);
            if (!cidMatch || !rtypeMatch) return null;

            const cid = cidMatch[1];
            const rtype = rtypeMatch[1];

            const keys = [...pageHtml.matchAll(/'(data-[a-z0-9]+)'/g)].map(m => m[1]).slice(0, 3);
            if (keys.length < 3) return null;

            const elRegex = new RegExp(`id=["']${cid}["'][^>]*`);
            const elMatch = pageHtml.match(elRegex);
            if (!elMatch) return null;
            const el = elMatch[0];

            const tokenParts = [];
            for (const k of keys) {
                const valMatch = el.match(new RegExp(`${k}=["']([^"']*)["']`));
                if (valMatch) tokenParts.push(valMatch[1]);
            }
            const token = tokenParts.join('');
            if (token.length < 6) return null;

            const reversed = token.split('').reverse().join('');
            const targetUrl = `${BASE_URL}/searcho/?${rtype}r=${reversed}`;

            // 2. Resolve redirect target (fast manual Location header check first)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);
            try {
                const res = await fetch(targetUrl, {
                    headers: {
                        ...this.headers,
                        'Referer': searchoUrl
                    },
                    redirect: 'manual',
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                const loc = res.headers.get('location');
                if (loc) {
                    return loc.startsWith('http') ? loc : new URL(loc, BASE_URL).toString();
                }
                if (res.url && res.url !== targetUrl && !res.url.includes('jav.guru/searcho')) {
                    return res.url;
                }
            } catch {
                clearTimeout(timeoutId);
            }

            // Fallback: follow redirects with curl -Ls -o /dev/null -w %{url_effective}
            try {
                const { stdout } = await execFileAsync(CURL_BIN, [
                    '-sL', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
                    '-w', '%{url_effective}',
                    '--max-time', '12',
                    '-A', this.headers['User-Agent'],
                    '-H', `Referer: ${searchoUrl}`,
                    targetUrl
                ], { windowsHide: true });
                const eff = (stdout || '').trim();
                if (eff && eff !== targetUrl && !eff.includes('jav.guru/searcho')) {
                    return eff;
                }
            } catch {}

            return null;
        } catch {
            return null;
        }
    }
}
