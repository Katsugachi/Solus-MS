/* ============================================================================
   Solus MS - Offline Mode service worker (sw.js)
   ============================================================================
   Registered ONLY when the user turns on "Offline Mode" in Settings (see
   offline.js). When Offline Mode is off this file is never registered, never
   runs, and the site behaves exactly as it always has.

   What it does, per request type (GET only - everything else is untouched):

   1. Launcher navigations  ( / or index.html )
      Network-first, cached copy as the offline fallback, so site updates
      always win when online and the launcher still opens with no internet.

   2. Game pages inside this site's scope (undertale.html, celeste.html, ...)
      Cache-first with background revalidation: instant repeat loads, and
      any pushed fix replaces the cached copy for the next launch.

   3. Game files pulled straight from a CDN inside those pages
      (cdn.jsdelivr.net, *.githack.com, raw.githubusercontent.com, ...)
      Cache-first. Every file a game downloads while you play it online is
      stored, so the same game boots fully offline afterwards. These CDN
      URLs are pinned to immutable commits, so cache-first cannot go stale.

   4. Games hosted on other repos / sites and iframed by a page here
      (e.g. katsugachi.github.io/Balatro-WASM/ inside balatro.html)
      Same rule as the CDNs: the worker fetches from the repo hosting the
      game and caches every response that passes through it. Nothing is
      crawled or pre-downloaded - a game's files are stored simply by
      playing it once online, exactly as the game itself loads them.

   Safety rules baked in below:
   - NEVER touches localStorage / IndexedDB: game progress cannot be
     affected by anything this worker does. It only reads/writes the three
     Cache Storage buckets named here.
   - NEVER caches non-GET requests, error responses, partial (206)
     responses, analytics traffic, or anything that is not http(s).
   - Any unexpected failure falls back to a plain network fetch, so a bug
     here degrades to "site behaves like Offline Mode was never on" rather
     than a broken page.

   Maintenance: when games or cover images are added/removed, update
   SHELL_FILES and bump CACHE_VERSION so old caches are cleaned up on the
   next visit. The list is scope-relative, so it works identically on
   GitHub Pages (/Solus-MS/) and on the root-domain mirrors.
   ============================================================================ */

'use strict';

var CACHE_VERSION = 'v1';
var SHELL_CACHE = 'solus-shell-' + CACHE_VERSION;   // launcher + site files
var GAMES_CACHE = 'solus-games-' + CACHE_VERSION;   // CDN / game-repo assets
var ALL_CACHES = [SHELL_CACHE, GAMES_CACHE];

// Analytics must always hit the real network and is useless offline.
var NEVER_CACHE_HOSTS = [
    'www.googletagmanager.com',
    'www.google-analytics.com',
    'www.google.com', // only used for gtag/redirects from this app; game CDNs unaffected
    'analytics.google.com',
    'region1.google-analytics.com',
    'stats.g.doubleclick.net',
    'www.doubleclick.net'
];

// Everything the launcher itself needs to open offline. Runtime caching
// fills in anything missed here, so a typo costs one online visit, not a
// broken offline launch. NOTE: mc263.html (78MB, fully self-contained) is
// deliberately NOT precached - it is cached on first play instead, like
// every other game's files.
var SHELL_FILES = [
    './',
    'index.html',
    'offline.html',
    'offline.js',
    'favicon.ico',
    'Slope.html',
    'StrHK.html',
    'ag.png',
    'amongus.html',
    'balatro.html',
    'balatro.jpg',
    'bg2.png',
    'bi.html',
    'bi.png',
    'celeste.html',
    'celeste.jpg',
    'cross.html',
    'cross.png',
    'crossy.html',
    'crossyroad.png',
    'cuphead.html',
    'cuphead.png',
    'deltarune.html',
    'deltarune.png',
    'eden.html',
    'eden.png',
    'ff7.html',
    'ff7.png',
    'gd.html',
    'gd.png',
    'gta.html',
    'gta.png',
    'hk.jpg',
    'hkp.html',
    'ink.html',
    'ink.png',
    'jsab.html',
    'jsab.png',
    'leveldevil.html',
    'leveldevil.png',
    'mariods.html',
    'mariods.png',
    'minecraft.jpg',
    'omori.html',
    'omori.png',
    'osu.html',
    'osu.png',
    'pt.html',
    'pt.jpg',
    'run-3.png',
    'run3.html',
    'rw.html',
    'rw.jpg',
    'sansfight.html',
    'sheepy.html',
    'sheepy.png',
    'skong.jpg',
    'slope.jpg',
    'ss.html',
    'stardew.html',
    'stardew.png',
    'sts.html',
    'sts.png',
    'sts2.html',
    'terraria.html',
    'terraria.jpg',
    'undertale.html',
    'undertale.png',
    'undertaley.html',
    'utgg.html',
    'utgg.jpg',
    'uy.png',
    'woim.html',
    'woim.jpg',
    'zelda.html',
    'zelda.png'
];

var SCOPE_URL = new URL(self.registration.scope);
var SCOPE_PATH = SCOPE_URL.pathname; // e.g. "/Solus-MS/" or "/"

function scopeUrl(relativePath) {
    return new URL(relativePath, self.registration.scope).href;
}

function isInScope(url) {
    return url.origin === SCOPE_URL.origin && url.pathname.indexOf(SCOPE_PATH) === 0;
}

function isLauncherNavigation(url) {
    if (!isInScope(url)) return false;
    var rest = url.pathname.slice(SCOPE_PATH.length);
    return rest === '' || rest === 'index.html';
}

/* ---------- cache helpers ---------- */

function isCacheableResponse(response) {
    if (!response) return false;
    // 200 = normal success, 0 = opaque cross-origin (script/img tags).
    // Redirects are already followed by fetch; 206 partials and errors
    // must never be stored (a stored 206 corrupts later full reads).
    if (response.status !== 200 && response.status !== 0) return false;
    // Respect an explicit no-store on readable responses.
    try {
        var cc = response.headers.get('Cache-Control');
        if (cc && /no-store/i.test(cc)) return false;
    } catch (e) { /* opaque responses expose no headers - fine */ }
    return true;
}

function putInCache(cacheName, request, response) {
    if (!isCacheableResponse(response)) return Promise.resolve();
    var copy;
    try { copy = response.clone(); } catch (e) { return Promise.resolve(); }
    return caches.open(cacheName)
        .then(function (cache) { return cache.put(request, copy); })
        .catch(function () { /* quota / opaque quirks: caching is best-effort */ });
}

// Exact match first, then a query-string-insensitive match. Games love
// cache-busting "?v=123" suffixes; the underlying pinned file is the same.
function matchAnyCache(request) {
    return caches.match(request).then(function (hit) {
        if (hit) return hit;
        var url = request.url;
        if (url.indexOf('?') !== -1 || url.indexOf('#') !== -1) {
            return caches.match(request, { ignoreSearch: true });
        }
        return undefined;
    });
}

function offlineFallbackResponse() {
    return caches.match(scopeUrl('offline.html')).then(function (hit) {
        if (hit) return hit;
        // Last resort if even the shell precache never ran: a self-contained
        // notice so the user never sees a raw browser error page.
        return new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Offline - Solus MS</title>' +
            '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
            'background:#1e283a;color:#e0e6ed;font-family:"Segoe UI",Tahoma,Geneva,Verdana,sans-serif;text-align:center;padding:24px}' +
            'h1{color:#007bff;font-weight:300}p{opacity:.8;line-height:1.5}</style></head><body><div>' +
            '<h1>You are offline</h1><p>This page has not been cached yet.<br>' +
            'Reconnect to the internet and open it once, and Offline Mode will keep it for next time.</p>' +
            '</div></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
    });
}

/* ---------- strategies ---------- */

// Launcher entry: freshest copy wins online, cache keeps it alive offline.
function networkFirstNavigation(request) {
    return fetch(request).then(function (response) {
        // Store under the canonical index URL as well as the request URL so
        // "/" and "/index.html" can both be served offline.
        putInCache(SHELL_CACHE, request, response);
        return response;
    }).catch(function () {
        return matchAnyCache(request).then(function (hit) {
            if (hit) return hit;
            return caches.match(scopeUrl('index.html')).then(function (indexHit) {
                return indexHit || offlineFallbackResponse();
            });
        });
    });
}

// Serve instantly from cache, refresh the copy in the background.
function staleWhileRevalidate(request, cacheName, waitUntil) {
    return matchAnyCache(request).then(function (cached) {
        var network = fetch(request).then(function (response) {
            putInCache(cacheName, request, response);
            return response;
        });
        if (cached) {
            if (waitUntil) waitUntil(network.catch(function () {}));
            return cached;
        }
        return network;
    });
}

// Immutable game assets: cache wins outright, network fills gaps.
function cacheFirst(request, cacheName) {
    return matchAnyCache(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
            putInCache(cacheName, request, response);
            return response;
        });
    });
}

// Requests that explicitly demand revalidation (a game's own no-cache
// reload of its entry files) skip the cache read but still update the
// stored copy.
function networkRevalidating(request, cacheName) {
    return fetch(request).then(function (response) {
        putInCache(cacheName, request, response);
        return response;
    }).catch(function (err) {
        return matchAnyCache(request).then(function (hit) {
            if (hit) return hit;
            throw err;
        });
    });
}

// Media elements and some loaders ask for byte ranges. If the full file is
// cached and readable, answer with a proper 206 slice; otherwise let the
// network handle it exactly as it would without a service worker.
function handleRangeRequest(request) {
    return matchAnyCache(request).then(function (cached) {
        if (!cached || cached.type === 'opaque') {
            // Opaque bodies cannot be read/sliced by the worker.
            return fetch(request).catch(function (err) {
                if (cached) return cached; // full-body 200 beats a hard error
                throw err;
            });
        }
        return cached.arrayBuffer().then(function (buffer) {
            var rangeHeader = request.headers.get('Range') || '';
            var match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
            if (!match) return new Response(buffer, { status: 200, headers: cached.headers });
            var total = buffer.byteLength;
            var start, end;
            if (match[1] === '') { // suffix range: last N bytes
                var suffix = parseInt(match[2], 10);
                if (!suffix) return new Response(buffer, { status: 200, headers: cached.headers });
                start = Math.max(0, total - suffix);
                end = total - 1;
            } else {
                start = parseInt(match[1], 10);
                end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
            }
            if (isNaN(start) || isNaN(end) || start > end || start >= total) {
                return new Response(null, {
                    status: 416,
                    headers: { 'Content-Range': 'bytes */' + total }
                });
            }
            var headers = new Headers(cached.headers);
            headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
            headers.set('Content-Length', String(end - start + 1));
            headers.set('Accept-Ranges', 'bytes');
            return new Response(buffer.slice(start, end + 1), { status: 206, headers: headers });
        });
    }).catch(function () {
        return fetch(request);
    });
}

/* ---------- fetch routing ---------- */

self.addEventListener('fetch', function (event) {
    var request = event.request;

    // Only plain GET reads are ever intercepted. POST/PUT/etc. (analytics
    // beacons, any future API calls) go straight to the network untouched.
    if (request.method !== 'GET') return;

    var url;
    try { url = new URL(request.url); } catch (e) { return; }

    // blob:/data:/chrome-extension: game loaders mint blob: URLs for their
    // wasm/data at runtime - those must never be intercepted or cached.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    if (NEVER_CACHE_HOSTS.indexOf(url.hostname) !== -1) return;

    var waitUntil = function (p) { try { event.waitUntil(p); } catch (e) {} };

    try {
        if (request.headers.get('Range')) {
            event.respondWith(handleRangeRequest(request));
            return;
        }

        var wantsRevalidate = request.cache === 'no-cache' || request.cache === 'reload';

        if (request.mode === 'navigate') {
            if (isLauncherNavigation(url)) {
                event.respondWith(networkFirstNavigation(request));
            } else if (isInScope(url)) {
                // Game pages + offline helpers: instant from cache, kept fresh
                // in the background; friendly notice if never cached & offline.
                event.respondWith(
                    staleWhileRevalidate(request, SHELL_CACHE, waitUntil)
                        .catch(function () { return offlineFallbackResponse(); })
                );
            } else if (url.origin === SCOPE_URL.origin) {
                // Same-origin game hosted outside this scope (the outer iframe
                // of a wrapper page). Fetched from the repo hosting the game
                // and cached like any other game file - network-first so a
                // pushed update wins; offline falls back to the cached copy,
                // then to the notice page.
                event.respondWith(
                    fetch(request).then(function (response) {
                        putInCache(GAMES_CACHE, request, response);
                        return response;
                    }).catch(function () {
                        return matchAnyCache(request).then(function (hit) {
                            return hit || offlineFallbackResponse();
                        });
                    })
                );
            } else {
                // Cross-origin iframe navigations (third-party game hosts):
                // pass through, only swapping a network failure for the
                // themed offline notice when this worker sees the request.
                event.respondWith(
                    fetch(request).catch(function () { return offlineFallbackResponse(); })
                );
            }
            return;
        }

        // ---- subresources ----
        if (isInScope(url)) {
            // Cover images, offline.js and anything else the site ships.
            event.respondWith(
                staleWhileRevalidate(request, SHELL_CACHE, waitUntil)
                    .catch(function () { return fetch(request); })
            );
        } else if (url.origin === SCOPE_URL.origin) {
            // Files from a same-origin repo outside this scope: fetched from
            // that repo on a miss and cached like any other game asset.
            event.respondWith(
                (wantsRevalidate
                    ? networkRevalidating(request, GAMES_CACHE)
                    : cacheFirst(request, GAMES_CACHE)
                ).catch(function () { return fetch(request); })
            );
        } else {
            // CDN game assets (jsDelivr / githack / raw.githubusercontent /
            // fonts): immutable, cache-first.
            event.respondWith(
                (wantsRevalidate
                    ? networkRevalidating(request, GAMES_CACHE)
                    : cacheFirst(request, GAMES_CACHE)
                ).catch(function () { return fetch(request); })
            );
        }
    } catch (err) {
        // Absolute last resort: behave as if this worker did not exist.
        try { event.respondWith(fetch(request)); } catch (e) {}
    }
});

/* ---------- lifecycle ---------- */

function precacheShell(reportProgress) {
    var done = 0;
    var failed = [];
    return caches.open(SHELL_CACHE).then(function (cache) {
        var chain = Promise.resolve();
        SHELL_FILES.forEach(function (file) {
            chain = chain.then(function () {
                var request = new Request(scopeUrl(file), { cache: 'reload' });
                return fetch(request).then(function (response) {
                    if (!isCacheableResponse(response)) throw new Error('HTTP ' + response.status);
                    return cache.put(request, response);
                }).then(function () {
                    done++;
                    if (reportProgress) reportProgress(done, SHELL_FILES.length);
                }).catch(function () {
                    done++;
                    failed.push(file);
                    if (reportProgress) reportProgress(done, SHELL_FILES.length);
                });
            });
        });
        return chain.then(function () { return { done: done, total: SHELL_FILES.length, failed: failed }; });
    });
}

self.addEventListener('install', function (event) {
    // Minimal core first so even an interrupted enable leaves a bootable
    // offline shell; offline.js then asks for the full precache (with
    // progress reporting) right after registration.
    event.waitUntil(
        caches.open(SHELL_CACHE).then(function (cache) {
            var core = ['./', 'index.html', 'offline.html', 'offline.js', 'favicon.ico'];
            return Promise.all(core.map(function (file) {
                var request = new Request(scopeUrl(file), { cache: 'reload' });
                return fetch(request).then(function (response) {
                    if (isCacheableResponse(response)) return cache.put(request, response);
                }).catch(function () {});
            }));
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(names.map(function (name) {
                // Only ever delete OUR OWN old versions.
                if (name.indexOf('solus-') === 0 && ALL_CACHES.indexOf(name) === -1) {
                    return caches.delete(name);
                }
                return null;
            }));
        }).then(function () { return self.clients.claim(); })
    );
});

/* ---------- page <-> worker messages ---------- */

self.addEventListener('message', function (event) {
    var data = event.data || {};
    var port = (event.ports && event.ports[0]) || null;
    var reply = function (msg) {
        if (port) { try { port.postMessage(msg); } catch (e) {} }
        else if (event.source) { try { event.source.postMessage(msg); } catch (e) {} }
    };

    if (data.type === 'SOLUS_PRECACHE_SHELL') {
        event.waitUntil(
            precacheShell(function (done, total) {
                reply({ type: 'SOLUS_PRECACHE_PROGRESS', done: done, total: total });
            }).then(function (result) {
                reply({ type: 'SOLUS_PRECACHE_DONE', done: result.done, total: result.total, failed: result.failed });
            }).catch(function () {
                reply({ type: 'SOLUS_PRECACHE_DONE', done: 0, total: SHELL_FILES.length, failed: ['*'] });
            })
        );
    } else if (data.type === 'SOLUS_GET_STATUS') {
        event.waitUntil(
            Promise.all(ALL_CACHES.map(function (name) {
                return caches.open(name).then(function (cache) { return cache.keys(); })
                    .then(function (keys) { return [name, keys.length]; })
                    .catch(function () { return [name, 0]; });
            })).then(function (pairs) {
                var counts = {};
                pairs.forEach(function (p) { counts[p[0]] = p[1]; });
                reply({ type: 'SOLUS_STATUS', caches: counts });
            })
        );
    } else if (data.type === 'SOLUS_SKIP_WAITING') {
        self.skipWaiting();
    }
});
