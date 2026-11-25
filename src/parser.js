/**
 * JAV.guru HTML & Searcho Embed Parser
 * Zero-dependency parser for catalog cards, pagination, video dossiers,
 * and multi-server player searcho iframe tokens.
 */

import { BASE_URL } from './config.js';

export function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&#(\d+);/g, (_, dec) => {
            try {
                return String.fromCharCode(parseInt(dec, 10));
            } catch {
                return '';
            }
        })
        .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => {
            try {
                return String.fromCharCode(parseInt(hex, 16));
            } catch {
                return '';
            }
        })
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&rsquo;/g, "'")
        .replace(/&lsquo;/g, "'")
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/&hellip;/g, '...')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extracts JAV code from title or slug (e.g. "KSBJ-454", "IPZZ-976", "FC2-PPV-123456").
 */
export function extractJavCode(text) {
    if (!text || typeof text !== 'string') return null;

    // Pattern 1: [CODE-123] in brackets
    const bracketMatch = text.match(/\[([a-zA-Z0-9_ -]{3,20})\]/);
    if (bracketMatch) return bracketMatch[1].trim().toUpperCase();

    // Pattern 2: Standard prefix-number code
    const codeMatch = text.match(/\b([A-Za-z]{2,8}[-_]\d{2,6}|FC2(?:-PPV)?[-_]\d{4,8})\b/i);
    if (codeMatch) return codeMatch[1].toUpperCase();

    return null;
}

/**
 * Parses catalog cards from browse pages (e.g. / or /page/2/).
 */
export function parseCatalogPage(html) {
    if (!html || typeof html !== 'string') return [];

    const items = [];
    const seenIds = new Set();

    // Match links matching: /1081223/slug-here/
    const linkRegex = /<a[^>]*href=["'](?:https?:\/\/jav\.guru)?\/(\d+)\/([^"'\/\s?#]+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
        const id = parseInt(match[1], 10);
        const slug = match[2];
        const innerHtml = match[3];

        if (isNaN(id) || seenIds.has(id)) continue;

        // Image / Poster
        const imgMatch = innerHtml.match(/src=["']([^"']+)["']/i) ||
                         innerHtml.match(/data-src=["']([^"']+)["']/i);
        const poster = imgMatch ? imgMatch[1].trim() : null;

        // Title from img alt or text
        let title = '';
        const altMatch = innerHtml.match(/alt=["']([^"']+)["']/i);
        if (altMatch) {
            title = decodeHtmlEntities(altMatch[1]);
        }
        if (!title) {
            title = decodeHtmlEntities(innerHtml.replace(/<[^>]+>/g, '')).trim();
        }
        if (!title) {
            title = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        }

        const code = extractJavCode(title) || extractJavCode(slug);

        seenIds.add(id);
        items.push({
            id,
            code,
            title,
            slug,
            poster,
            url: `${BASE_URL}/${id}/${slug}/`
        });
    }

    return items;
}

/**
 * Extracts total pages count from pagination element (e.g. /page/5791/).
 */
export function parseCatalogPagination(html, fallbackTotal = 5791) {
    if (!html || typeof html !== 'string') return fallbackTotal;

    const pageNumMatches = [...html.matchAll(/\/page\/(\d+)\//g)];
    let maxFound = fallbackTotal;
    for (const m of pageNumMatches) {
        const num = parseInt(m[1].replace(/,/g, ''), 10);
        if (!isNaN(num) && num > maxFound) maxFound = num;
    }

    return maxFound;
}

/**
 * Resolves a JAV.guru searcho token page to its final redirect embed URL.
 */
export function resolveSearchoToken(searchoHtml) {
    if (!searchoHtml || typeof searchoHtml !== 'string') return null;

    const cidMatch = searchoHtml.match(/cid:\s*'([a-z0-9]+)'/);
    const rtypeMatch = searchoHtml.match(/rtype:\s*'([a-z]+)'/);
    if (!cidMatch || !rtypeMatch) return null;

    const cid = cidMatch[1];
    const rtype = rtypeMatch[1];

    const keys = [...searchoHtml.matchAll(/'(data-[a-z0-9]+)'/g)].map(m => m[1]).slice(0, 3);
    if (keys.length < 3) return null;

    const elRegex = new RegExp(`id=["']${cid}["'][^>]*`);
    const elMatch = searchoHtml.match(elRegex);
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
    return `${BASE_URL}/searcho/?${rtype}r=${reversed}`;
}

/**
 * Parses video detail page HTML (metadata, infometa, actress, director, studio, stream servers).
 */
export function parseDetailHtml(html, pageUrl = '', catalogItem = {}) {
    if (!html || typeof html !== 'string') return null;

    // ID
    let id = catalogItem.id || null;
    if (!id && pageUrl) {
        const idMatch = pageUrl.match(/\/(\d+)\//);
        if (idMatch) id = parseInt(idMatch[1], 10);
    }

    // Title
    let title = catalogItem.title || '';
    const h1Match = html.match(/<h1[^>]*class=["'][^"']*titl[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
                    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
        title = decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, '')).trim();
    } else if (!title) {
        const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
        if (ogTitle) title = decodeHtmlEntities(ogTitle[1]);
    }

    // Canonical URL & Slug
    const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    const canonicalUrl = canonicalMatch ? canonicalMatch[1].trim() : pageUrl;
    let slug = catalogItem.slug || '';
    if (!slug || /^\d+$/.test(slug)) {
        const slugMatch = canonicalUrl.match(/\/(\d+)\/([^"'\/\s?#]+)\/?/);
        if (slugMatch) slug = slugMatch[2];
    }
    if (!slug && canonicalUrl) {
        slug = canonicalUrl.split('/').filter(Boolean).pop() || '';
    }

    // Code
    let code = catalogItem.code || extractJavCode(title);
    const codeMatch = html.match(/Code:\s*<\/span><\/strong>\s*([A-Za-z0-9_-]+)/i);
    if (codeMatch) {
        code = codeMatch[1].trim().toUpperCase();
    }

    // Release Date & Year
    let releaseDate = null;
    let year = null;
    const dateMatch = html.match(/Release Date:\s*<\/span><\/strong>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
    if (dateMatch) {
        releaseDate = dateMatch[1];
        year = parseInt(releaseDate.slice(0, 4), 10);
    } else {
        const yMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
        if (yMatch) year = parseInt(yMatch[1], 10);
    }

    // Poster
    let poster = catalogItem.poster || null;
    const posterMatch = html.match(/class=["'][^"']*large-screenimg[^"']*["'][\s\S]*?<img[^>]*src=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    if (posterMatch) poster = posterMatch[1].trim();

    // Scope Infometa details: Category, Actresses, Actors, Director, Studio, Label, Genres/Tags
    const infometaMatch = html.match(/<div[^>]*class=["'][^"']*infometa[^"']*["'][\s\S]*?(?:<\/div>\s*<\/div>|<div class="clear"|<div class="large-screenimg")/i) ||
                          html.match(/<div[^>]*class=["'][^"']*infoleft[^"']*["'][\s\S]*?<\/ul>/i);
    const scopeHtml = infometaMatch ? infometaMatch[0] : (html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html);

    let category = null;
    const catMatch = scopeHtml.match(/Category:<\/strong>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    if (catMatch) category = decodeHtmlEntities(catMatch[1].replace(/<[^>]+>/g, '')).trim();

    const actresses = [];
    const actressMatches = [...scopeHtml.matchAll(/<a[^>]*href=["'][^"']*\/actress\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const am of actressMatches) {
        const name = decodeHtmlEntities(am[1].replace(/<[^>]+>/g, '')).replace(/\s*\(\d+\)$/, '').trim();
        if (name && !actresses.includes(name)) actresses.push(name);
    }

    const actors = [];
    const actorMatches = [...scopeHtml.matchAll(/<a[^>]*href=["'][^"']*\/actor\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const am of actorMatches) {
        const name = decodeHtmlEntities(am[1].replace(/<[^>]+>/g, '')).replace(/\s*\(\d+\)$/, '').trim();
        if (name && !actors.includes(name)) actors.push(name);
    }

    let director = null;
    const dirMatch = scopeHtml.match(/<a[^>]*href=["'][^"']*\/director\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i);
    if (dirMatch) director = decodeHtmlEntities(dirMatch[1].replace(/<[^>]+>/g, '')).trim();

    let studio = null;
    const stuMatch = scopeHtml.match(/<a[^>]*href=["'][^"']*\/(?:maker|studio)\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i);
    if (stuMatch) studio = decodeHtmlEntities(stuMatch[1].replace(/<[^>]+>/g, '')).trim();

    let label = null;
    const labMatch = scopeHtml.match(/<a[^>]*href=["'][^"']*\/(?:label|studio)\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i);
    if (labMatch) label = decodeHtmlEntities(labMatch[1].replace(/<[^>]+>/g, '')).trim();

    const tags = [];
    const tagMatches = [...scopeHtml.matchAll(/<a[^>]*href=["'][^"']*\/(?:genre|tag)\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const tm of tagMatches) {
        const t = decodeHtmlEntities(tm[1].replace(/<[^>]+>/g, '')).replace(/\s*\(\d+\)$/, '').trim();
        if (t && !tags.includes(t)) tags.push(t);
    }

    // Synopsis
    let synopsis = '';
    const synMatch = html.match(/<div[^>]*class=["'][^"']*wp-content[^"']*["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    if (synMatch) {
        synopsis = decodeHtmlEntities(synMatch[1].replace(/<[^>]+>/g, '')).trim();
    } else {
        const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
        if (ogDesc) synopsis = decodeHtmlEntities(ogDesc[1]).trim();
    }

    // Screenshots
    const screenshots = [];
    const imgMatches = [...html.matchAll(/<img[^>]*src=["'](https?:\/\/[^"']*(?:gallery|preview|screenshot)[^"']*)["']/gi)];
    for (const im of imgMatches) {
        if (!screenshots.includes(im[1])) screenshots.push(im[1]);
    }

    // --- Stream Servers Extraction ---
    const streams = [];

    // 1. Build map from localized buttons: data-localize="varName" -> button text (e.g. STREAM SB, STREAM VO)
    const buttonMap = new Map();
    const btnRegex = /<a[^>]*class=["'][^"']*wp-btn-iframe__shortcode[^"']*["'][^>]*data-localize=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let bMatch;
    while ((bMatch = btnRegex.exec(html)) !== null) {
        const varName = bMatch[1].trim();
        const btnText = decodeHtmlEntities(bMatch[2].replace(/<[^>]+>/g, '')).trim();
        buttonMap.set(varName, btnText);
    }

    // 2. Extract script objects: var <varName> = { "iframe_url": "..." };
    const scriptRegex = /var\s+([a-zA-Z0-9_]+)\s*=\s*(\{"btn_class"[\s\S]*?\});/gi;
    let sMatch;
    let serverIdx = 1;

    while ((sMatch = scriptRegex.exec(html)) !== null) {
        const varName = sMatch[1];
        try {
            const parsedCfg = JSON.parse(sMatch[2]);
            if (parsedCfg.iframe_url) {
                const searchoUrl = Buffer.from(parsedCfg.iframe_url, 'base64').toString('utf8');
                const serverName = buttonMap.get(varName) || `Server ${serverIdx}`;

                streams.push({
                    server_id: String(serverIdx),
                    server_name: serverName,
                    searcho_url: searchoUrl,
                    url: searchoUrl,
                    type: 'iframe'
                });
                serverIdx++;
            }
        } catch {}
    }

    // Fallback: If no script objects matched, look directly for base64 iframe_url fields
    if (streams.length === 0) {
        const b64IframeMatches = [...html.matchAll(/"iframe_url":"([A-Za-z0-9+/=]+)"/g)];
        for (let i = 0; i < b64IframeMatches.length; i++) {
            try {
                const decoded = Buffer.from(b64IframeMatches[i][1], 'base64').toString('utf8');
                streams.push({
                    server_id: String(i + 1),
                    server_name: `Server ${i + 1}`,
                    searcho_url: decoded,
                    url: decoded,
                    type: 'iframe'
                });
            } catch {}
        }
    }

    // Also look for direct third-party hoster iframes in HTML
    const hosterIframes = [...html.matchAll(/<iframe[^>]*src=["'](https?:\/\/[^"']+)["']/gi)]
        .map(m => m[1])
        .filter(u => !u.includes('jav.guru') && !u.includes('google') && !u.includes('disqus') && !u.includes('smartpop') && !u.includes('mayzaent'));

    for (const hIframe of hosterIframes) {
        if (!streams.some(s => s.url === hIframe)) {
            streams.push({
                server_id: String(streams.length + 1),
                server_name: `Direct Player ${streams.length + 1}`,
                searcho_url: null,
                url: hIframe,
                type: 'iframe'
            });
        }
    }

    return {
        id: id || catalogItem.id,
        code: code || catalogItem.code,
        title: title || catalogItem.title,
        slug: slug || catalogItem.slug || (pageUrl ? pageUrl.split('/').filter(Boolean).pop() : ''),
        release_date: releaseDate,
        year,
        category,
        actresses,
        actors,
        director,
        studio,
        label,
        genres: tags,
        poster,
        screenshots,
        synopsis,
        streams,
        url: canonicalUrl || pageUrl || catalogItem.url
    };
}
