// Solus MS offline mode service worker.
// Registered from index.html only while Offline Mode is enabled in Settings;
// turning the setting off unregisters it and deletes every cache below.
//
// Games fall into two categories, both detected from the URL alone so new
// games are picked up automatically:
//   1. Mirrored pages - a launcher .html that iframes a page under one of
//      MIRROR_ORIGINS (e.g. https://katsugachi.github.io/<repo>/). A worker can
//      only control pages inside its own scope, so the iframe src is rewritten
//      to <scope>__mirror/<host>/<path> and this worker fetches the real page
//      and serves it from there, caching everything it loads.
//   2. CDN games - a launcher .html (with a <base> or absolute URLs) that pulls
//      its files from a CDN. The launcher page is controlled directly, so its
//      cross-origin requests are cached as they happen.

const CACHE_VERSION = 'v1';
const SITE_CACHE = 'solus-site-' + CACHE_VERSION;
const GAME_CACHE = 'solus-games-' + CACHE_VERSION;

const SCOPE = self.registration.scope;
const SCOPE_URL = new URL(SCOPE);
const MIRROR_PREFIX = SCOPE + '__mirror/';
// Only trusted, first-party prefixes may be mirrored: mirrored pages run
// with this site's origin, so they can read its saves and settings
const MIRROR_ORIGINS = ['https://katsugachi.github.io/', 'https://raw.githack.com/Katsugachi/'];

// Hosts that only serve static, versioned files: always cache-first
const STATIC_HOSTS = [
    'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'raw.githack.com', 'rawcdn.githack.com',
    'raw.githubusercontent.com', 'unpkg.com', 'cdnjs.cloudflare.com',
    'fonts.googleapis.com', 'fonts.gstatic.com'
];
const DYNAMIC_EXT = /\.(php|aspx?|cgi|jsp)$/i;
const SHELL_FILES = ['./', 'favicon.ico'];
const NETWORK_TIMEOUT_MS = 3500;
const MAX_REWRITE_BYTES = 2 * 1024 * 1024;

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SITE_CACHE);
        await Promise.all(SHELL_FILES.map(async (f) => {
            try {
                const res = await fetch(new Request(new URL(f, SCOPE), { cache: 'reload' }));
                if (res.ok) await cache.put(shellKey(new URL(f, SCOPE)), res);
            } catch (e) {}
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = [SITE_CACHE, GAME_CACHE];
        const names = await caches.keys();
        await Promise.all(names.filter(n => n.startsWith('solus-') && !keep.includes(n)).map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

// Sent by the page every time Offline Mode is (re)enabled. Re-enabling while
// old tabs keep a just-unregistered worker alive revives that same worker
// without a new install/activate, so take control and recreate the caches
// here too. Then warm the cache with cover images and other site files.
self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'precache' && Array.isArray(data.urls)) {
        event.waitUntil((async () => {
            const cache = await caches.open(SITE_CACHE);
            await caches.open(GAME_CACHE);
            await self.clients.claim();
            for (const u of data.urls) {
                try {
                    const url = new URL(u, SCOPE);
                    if (!url.href.startsWith(SCOPE)) continue;
                    if (await cache.match(url.href)) continue;
                    const res = await fetch(url.href);
                    if (res.ok) await cache.put(url.href, res);
                } catch (e) {}
            }
        })());
    }
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    let url;
    try { url = new URL(req.url); } catch (e) { return; }
    // Cache writes run in the background so responses stream straight to
    // the game instead of waiting for (possibly huge) files to be stored
    const keep = (p) => { try { event.waitUntil(p); } catch (e) {} };
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    // Mirrored game pages: every method has to be proxied, the path does not
    // exist on this host
    if (url.href.startsWith(MIRROR_PREFIX)) {
        event.respondWith(handleMirror(req, url, keep));
        return;
    }

    if (req.method === 'HEAD') { event.respondWith(handleHead(req, req.url)); return; }
    if (req.method !== 'GET') return;
    if (req.headers.has('range')) { event.respondWith(handleRange(req, req.url, null, keep)); return; }

    const inScope = url.href.startsWith(SCOPE);
    if (inScope) {
        if (url.pathname.endsWith('/sw.js')) return;
        if (isShell(url)) { event.respondWith(networkFirst(req, SITE_CACHE, shellKey(url), keep)); return; }
        if (/\.html?$/i.test(url.pathname)) {
            event.respondWith(serveDocument(req, url.href, GAME_CACHE, () => fetch(req), keep));
            return;
        }
        event.respondWith(staleWhileRevalidate(req.url, SITE_CACHE, () => fetch(req), keep));
        return;
    }

    // Everything outside the scope is game content (or fonts/icons the site uses)
    if (isStatic(url)) event.respondWith(cacheFirst(req.url, GAME_CACHE, () => fetch(req), keep));
    else event.respondWith(networkFirst(req, GAME_CACHE, req.url, keep));
});

// ---------- classification ----------

function isShell(url) {
    const rel = url.pathname.slice(SCOPE_URL.pathname.length);
    return url.origin === SCOPE_URL.origin && (rel === '' || rel === 'index.html');
}

function shellKey(url) {
    return isShell(url) ? SCOPE : url.href;
}

function isStatic(url) {
    if (STATIC_HOSTS.includes(url.hostname)) return true;
    const last = url.pathname.split('/').pop();
    return last.includes('.') && !DYNAMIC_EXT.test(last);
}

function isMirrorable(href) {
    return MIRROR_ORIGINS.some(p => href.startsWith(p));
}

function toMirror(href) {
    const u = new URL(href);
    return MIRROR_PREFIX + u.host + u.pathname + u.search + u.hash;
}

function fromMirror(href) {
    return 'https://' + href.slice(MIRROR_PREFIX.length);
}

// ---------- caching strategies ----------

function cacheable(res) {
    return res && (res.ok || res.type === 'opaque') && res.status !== 206;
}

async function putSafe(cacheName, key, res) {
    try {
        // Offline Mode being turned off deletes the caches before the worker
        // unregisters; pages it still controls must not recreate them
        if (!(await caches.has(SITE_CACHE))) return;
        const cache = await caches.open(cacheName);
        await cache.put(key, res);
    } catch (e) {
        // Quota exceeded or an unstorable response: play on without caching
    }
}

async function fetchAndStore(key, cacheName, fetcher, keep) {
    const res = await fetcher();
    if (cacheable(res)) keep(putSafe(cacheName, key, res.clone()));
    return res;
}

async function cacheFirst(key, cacheName, fetcher, keep) {
    const hit = await caches.match(key, { ignoreVary: true });
    if (hit) return hit;
    try {
        return await fetchAndStore(key, cacheName, fetcher, keep);
    } catch (e) {
        return Response.error();
    }
}

async function staleWhileRevalidate(key, cacheName, fetcher, keep) {
    const hit = await caches.match(key, { ignoreVary: true });
    const update = fetchAndStore(key, cacheName, fetcher, keep).catch(() => null);
    if (hit) { keep(update); return hit; }
    return (await update) || Response.error();
}

async function networkFirst(req, cacheName, key, keep) {
    const network = fetchAndStore(key, cacheName, () => fetch(req), keep);
    keep(network.catch(() => {}));
    try {
        return await withTimeout(network, NETWORK_TIMEOUT_MS);
    } catch (e) {
        const hit = await caches.match(key, { ignoreVary: true });
        if (hit) return hit;
        try { return await network; } catch (err) {
            return req.mode === 'navigate' ? offlinePage() : Response.error();
        }
    }
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

// Launcher pages and mirrored entry pages: served from cache instantly, then
// revalidated in the background with a conditional request so an unchanged
// page (even the 78 MB Minecraft one) costs a 304 instead of a re-download.
async function serveDocument(req, key, cacheName, fetcher, keep, sameOrigin = true) {
    const hit = await caches.match(key, { ignoreVary: true });
    if (hit) {
        keep(revalidate(key, cacheName, hit, fetcher, sameOrigin).catch(() => {}));
        return rewriteDocument(hit);
    }
    try {
        const res = await fetchAndStore(key, cacheName, fetcher, keep);
        return rewriteDocument(res);
    } catch (e) {
        if (e.redirectTo) throw e;
        return req.mode === 'navigate' ? offlinePage() : Response.error();
    }
}

async function revalidate(key, cacheName, cached, fetcher, sameOrigin) {
    const etag = cached.headers.get('etag');
    const lastMod = cached.headers.get('last-modified');
    let res;
    if (sameOrigin && (etag || lastMod)) {
        const headers = {};
        if (etag) headers['If-None-Match'] = etag;
        if (lastMod) headers['If-Modified-Since'] = lastMod;
        res = await fetch(key, { headers, cache: 'no-store', credentials: 'same-origin' });
        if (res.status === 304) return;
    } else {
        res = await fetcher();
    }
    if (res.ok && !res.redirected) await putSafe(cacheName, key, res);
}

// Point iframes at mirrored hosts through this worker so they can be cached
async function rewriteDocument(res) {
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('text/html')) return res;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_REWRITE_BYTES) return res;
    const blob = await res.clone().blob();
    if (blob.size > MAX_REWRITE_BYTES) return res;
    const html = await blob.text();
    const out = html.replace(/(<iframe\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (m, pre, q, src) => {
        try {
            const u = new URL(src);
            if (!isMirrorable(u.href) || u.href.startsWith(SCOPE)) return m;
            return pre + q + toMirror(u.href) + q;
        } catch (e) { return m; }
    });
    if (out === html) return res;
    return new Response(out, { status: res.status, statusText: res.statusText, headers: cleanHeaders(res.headers) });
}

function cleanHeaders(headers) {
    const h = new Headers(headers);
    h.delete('content-encoding');
    h.delete('content-length');
    return h;
}

// ---------- mirrored pages ----------

async function handleMirror(req, url, keep) {
    const upstream = fromMirror(url.href);
    if (!isMirrorable(upstream)) return new Response('Not found', { status: 404 });
    const upstreamUrl = new URL(upstream);
    const sameOrigin = upstreamUrl.origin === self.location.origin;
    const mode = sameOrigin ? 'same-origin' : 'cors';
    const fetchUpstream = (init = {}) => fetch(upstream, Object.assign({ mode, credentials: 'omit', redirect: 'follow' }, init));

    if (req.method === 'HEAD') return handleHead(req, upstream, () => fetchUpstream({ method: 'HEAD' }));
    if (req.method !== 'GET') {
        try {
            return await fetchUpstream({ method: req.method, headers: req.headers, body: await req.arrayBuffer() });
        } catch (e) { return Response.error(); }
    }
    if (req.headers.has('range')) {
        return handleRange(req, upstream, () => fetchUpstream({ headers: { range: req.headers.get('range') } }), keep);
    }

    if (req.mode === 'navigate') {
        // Keep relative URLs resolving inside the mirror when GitHub Pages
        // redirects /repo to /repo/
        const fetcher = async () => {
            const res = await fetchUpstream();
            if (res.redirected && res.url && res.url !== upstream) {
                const err = new Error('redirect');
                err.redirectTo = res.url;
                throw err;
            }
            return res;
        };
        try {
            return reframe(await serveDocument(req, upstream, GAME_CACHE, fetcher, keep, sameOrigin));
        } catch (e) {
            if (e.redirectTo) return Response.redirect(toMirror(e.redirectTo), 302);
            return offlinePage();
        }
    }

    const res = isStatic(upstreamUrl)
        ? await cacheFirst(upstream, GAME_CACHE, () => fetchUpstream(), keep)
        : await networkFirst(new Request(upstream, { mode, credentials: 'omit' }), GAME_CACHE, upstream, keep);
    return reframe(res);
}

// Re-wrap a response so it is served as if it came from the mirror URL
function reframe(res) {
    if (!res || res.type === 'error' || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: cleanHeaders(res.headers) });
}

// ---------- HEAD and Range ----------

async function handleHead(req, key, fetcher) {
    try {
        return await (fetcher ? fetcher() : fetch(req));
    } catch (e) {
        const hit = await caches.match(key, { ignoreVary: true });
        if (hit && hit.type !== 'opaque') return new Response(null, { status: hit.status, headers: hit.headers });
        // Games probe for optional files with HEAD (e.g. split .data chunks);
        // anything never cached is reported missing rather than a network error
        return new Response(null, { status: 404, statusText: 'Not Found (offline)' });
    }
}

const rangeWarmups = new Set();

// Media elements stream with Range requests, which the Cache API cannot
// store. Serve slices of a cached full copy, and when a stream starts from the
// beginning fetch the full file once in the background for next time.
async function handleRange(req, key, fetcher, keep) {
    const range = req.headers.get('range') || '';
    const hit = await caches.match(key, { ignoreVary: true });
    if (hit && hit.type !== 'opaque') {
        const blob = await hit.blob();
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
            let start, end;
            if (m[1] === '') { start = Math.max(0, blob.size - Number(m[2])); end = blob.size - 1; }
            else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1; }
            if (start <= end && start < blob.size) {
                const headers = cleanHeaders(hit.headers);
                headers.set('Content-Range', `bytes ${start}-${end}/${blob.size}`);
                headers.set('Content-Length', String(end - start + 1));
                return new Response(blob.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
            }
        }
    }
    if (/^bytes=0-/.test(range) && isStatic(new URL(key)) && !rangeWarmups.has(key)) {
        rangeWarmups.add(key);
        keep(fetch(key, { credentials: 'omit' })
            .then((res) => res.ok ? putSafe(GAME_CACHE, key, res) : null)
            .catch(() => {})
            .finally(() => rangeWarmups.delete(key)));
    }
    try {
        return fetcher ? reframe(await fetcher()) : await fetch(req);
    } catch (e) {
        return Response.error();
    }
}

function offlinePage() {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Offline</title><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
        'background:#0b1220;color:#e6edf7;font:16px system-ui,sans-serif;text-align:center;padding:20px;box-sizing:border-box}' +
        'h1{font-size:1.3rem;margin:0 0 8px}p{opacity:.7;margin:0;max-width:420px}</style></head><body><div>' +
        '<h1>You are offline</h1><p>This page has not been cached yet. Connect to the internet and open it once ' +
        'with Offline Mode on to make it available offline.</p></div></body></html>';
    return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
