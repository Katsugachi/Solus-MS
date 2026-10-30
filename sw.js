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

   4. Games hosted on GitHub Pages repos and iframed by a page here
      (e.g. katsugachi.github.io/Balatro-WASM/ inside balatro.html)
      Those inner sites are outside this worker's scope, so their traffic
      never passes through here on its own. Instead, index.html routes
      them (only while Offline Mode is on) through repo-game.html, and
      offline.js caches the game's entire repository - identified from
      the wrapper's iframe URL, listed via the jsDelivr CDN API and
      downloaded file-by-file from the CDN - under its GitHub Pages URLs
      in the repo cache. Offline, repo-game.html loads the game from an
      in-scope mirror path on this origin (__solus_repo/<owner>/<repo>/...)
      and this worker answers the mirror's index.html - and every file
      the game then requests - from the repository cache. The mirror
      path keeps the document on the site's real origin (a srcdoc frame
      reports location.origin as "null", which origin-locked webports
      reject). Online the live game is loaded untouched.

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
var GAMES_CACHE = 'solus-games-' + CACHE_VERSION;   // CDN game assets
var REPO_CACHE = 'solus-repo-' + CACHE_VERSION;     // whole GitHub Pages game repos
var ALL_CACHES = [SHELL_CACHE, GAMES_CACHE, REPO_CACHE];

// Repository downloads (performed by offline.js, stored under GitHub
// Pages URLs) carry this query marker; the worker must not intercept
// them or it would store a second copy under the CDN URL.
var REPO_FETCH_PARAM = '__solus_repo_fetch';

// Offline GitHub Pages games run from this in-scope mirror prefix:
//   <scope>__solus_repo/<owner>/<repo>/<path inside the repo>
// The mirror document has this site's real origin (a srcdoc document
// reports location.origin as "null", which makes origin-locked
// webports refuse to start), and because the path is inside this
// worker's scope every file the game requests through the mirror can
// be answered from the repository cache by the proxy handler below.
var REPO_PROXY_PREFIX = '__solus_repo/';

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
    'repo-game.html',
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

function isGithubPagesHost(url) {
    return /\.github\.io$/i.test(url.hostname);
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

/* ---------- GitHub Pages repo mirror (offline repo games) ---------- */

function decodePathSegment(segment) {
    try { return decodeURIComponent(segment); } catch (e) { return segment; }
}

function encodeRepoPathSegments(segments) {
    return segments.map(function (segment) {
        return encodeURIComponent(segment);
    }).join('/');
}

// Parse <scope>__solus_repo/<owner>/<repo>/<path> into the GitHub Pages
// URL(s) the mirror request stands for. Directory (and extensionless)
// paths also get an index.html candidate.
function parseRepoProxyUrl(url) {
    if (!isInScope(url)) return null;
    var rest = url.pathname.slice(SCOPE_PATH.length);
    if (rest.indexOf(REPO_PROXY_PREFIX) !== 0) return null;

    var rawParts = rest.slice(REPO_PROXY_PREFIX.length).split('/');
    if (rawParts.length < 2) return null;
    var owner = decodePathSegment(rawParts[0]).toLowerCase();
    var repo = decodePathSegment(rawParts[1]);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(owner)) return null;
    if (!repo || repo === '.' || repo === '..' ||
        repo.indexOf('/') !== -1 || repo.indexOf('\\') !== -1) return null;

    var pathSegments = rawParts.slice(2).map(decodePathSegment)
        .filter(function (segment) { return segment.length; });
    for (var i = 0; i < pathSegments.length; i++) {
        if (pathSegments[i] === '.' || pathSegments[i] === '..') return null;
    }

    var isUserSite = repo.toLowerCase() === owner + '.github.io';
    var repoBaseUrl = 'https://' + owner + '.github.io' +
        (isUserSite ? '' : '/' + encodeURIComponent(repo)) + '/';

    function candidate(fileSegments, dirSegments) {
        return {
            url: repoBaseUrl + encodeRepoPathSegments(fileSegments),
            mirrorBaseUrl: scopeUrl(
                REPO_PROXY_PREFIX + encodeURIComponent(owner) + '/' +
                encodeURIComponent(repo) + '/' +
                (dirSegments.length ? encodeRepoPathSegments(dirSegments) + '/' : '')
            )
        };
    }

    var candidates;
    var last = pathSegments[pathSegments.length - 1] || '';
    if (!pathSegments.length || /\/$/.test(url.pathname)) {
        candidates = [candidate(pathSegments.concat(['index.html']), pathSegments)];
    } else if (/\.[a-z0-9]+$/i.test(last)) {
        candidates = [candidate(pathSegments, pathSegments.slice(0, -1))];
    } else {
        candidates = [
            candidate(pathSegments, pathSegments.slice(0, -1)),
            candidate(pathSegments.concat(['index.html']), pathSegments)
        ];
    }

    return { owner: owner, repo: repo, candidates: candidates };
}

function matchRepoCache(targetUrl) {
    return caches.open(REPO_CACHE).then(function (cache) {
        return cache.match(targetUrl).then(function (hit) {
            return hit || cache.match(targetUrl, { ignoreSearch: true });
        });
    }).then(function (hit) {
        return hit || caches.match(targetUrl, { ignoreSearch: true });
    }).catch(function () { return undefined; });
}

// Games routinely probe for optional files (alternate audio formats,
// optional configs) and proceed on an HTTP 404 - but hang forever on a
// network error, which is what a plain failed fetch produces offline.
// Answering "not in the cached repo" with a real 404 keeps those
// loaders moving exactly as they do against the live site.
function repoNotFoundResponse() {
    return new Response('Not found', {
        status: 404,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

// Point the served document's relative URLs at its mirror folder, so
// scripts, workers, imports and sibling navigations all stay inside
// the mirror (and therefore inside this worker's control).
function injectRepoBase(html, baseUrl) {
    if (/<base\s[^>]*href\s*=/i.test(html)) return html;
    var tag = '<base href="' + String(baseUrl).replace(/"/g, '%22') + '">';
    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head[^>]*>/i, function (m) { return m + tag; });
    }
    return tag + html;
}

function isRepoHtmlResponse(request, targetUrl, response) {
    if (request.mode === 'navigate') return true;
    try {
        var type = response.headers.get('Content-Type') || '';
        if (/text\/html/i.test(type)) return true;
    } catch (e) {}
    return /\.html?$/i.test(targetUrl);
}

// Cached GitHub Pages files were stored from cross-origin CORS fetches,
// so their response type is "cors". Chromium refuses to serve a "cors"
// response to same-origin requests such as dedicated Worker scripts
// (the game's physics worker then never starts). Re-wrapping the body
// yields a plain response that every request mode accepts.
function repoPlainResponse(response) {
    if (!response || response.type === 'opaque') return Promise.resolve(response);
    return response.clone().arrayBuffer().then(function (buffer) {
        var headers = new Headers();
        ['Content-Type', 'ETag', 'Last-Modified', 'Cache-Control'].forEach(function (name) {
            var value = response.headers.get(name);
            if (value) headers.set(name, value);
        });
        return new Response(buffer, { status: response.status || 200, headers: headers });
    }).catch(function () { return response; });
}

function repoProxyHtmlResponse(response, mirrorBaseUrl) {
    if (!response || response.type === 'opaque') return Promise.resolve(response);
    return response.clone().text().then(function (html) {
        // Clean headers: the stored response may carry CDN framing/CSP
        // headers that must not apply to the mirror document.
        return new Response(injectRepoBase(html, mirrorBaseUrl), {
            status: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            }
        });
    }).catch(function () { return response; });
}

function fetchRepoProxyCandidate(request, info, index) {
    if (index >= info.candidates.length) return Promise.resolve(null);
    var candidate = info.candidates[index];
    return matchRepoCache(candidate.url).then(function (hit) {
        if (hit) return { response: hit, candidate: candidate };
        return fetch(candidate.url, { credentials: 'omit', redirect: 'follow' })
            .then(function (response) {
                if (!response.ok && index + 1 < info.candidates.length) {
                    return fetchRepoProxyCandidate(request, info, index + 1);
                }
                putInCache(REPO_CACHE, candidate.url, response);
                return { response: response, candidate: candidate };
            })
            .catch(function () {
                return fetchRepoProxyCandidate(request, info, index + 1);
            });
    });
}

function handleRepoProxyRequest(request, info) {
    var rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
        var findCached = function (index) {
            if (index >= info.candidates.length) return Promise.resolve(null);
            return matchRepoCache(info.candidates[index].url).then(function (hit) {
                return hit ? info.candidates[index] : findCached(index + 1);
            });
        };
        return findCached(0).then(function (candidate) {
            if (candidate) {
                return handleRangeRequest(new Request(candidate.url, {
                    headers: { 'Range': rangeHeader }
                })).catch(function () { return repoNotFoundResponse(); });
            }
            return fetch(info.candidates[0].url, {
                credentials: 'omit',
                headers: { 'Range': rangeHeader }
            }).catch(function () { return repoNotFoundResponse(); });
        }).catch(function () { return repoNotFoundResponse(); });
    }

    return fetchRepoProxyCandidate(request, info, 0).then(function (found) {
        if (!found) {
            return request.mode === 'navigate'
                ? offlineFallbackResponse()
                : repoNotFoundResponse();
        }
        var response = found.response;
        if (request.mode === 'navigate' && (!response.ok || response.type === 'opaque')) {
            return offlineFallbackResponse();
        }
        if (isRepoHtmlResponse(request, found.candidate.url, response)) {
            return repoProxyHtmlResponse(response, found.candidate.mirrorBaseUrl);
        }
        return repoPlainResponse(response);
    }).catch(function () {
        return request.mode === 'navigate'
            ? offlineFallbackResponse()
            : repoNotFoundResponse();
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

    // Repository downloads by offline.js go straight to the network; it
    // stores them itself, once, under their GitHub Pages URLs.
    try { if (url.searchParams.get(REPO_FETCH_PARAM) === '1') return; } catch (e) {}

    var waitUntil = function (p) { try { event.waitUntil(p); } catch (e) {} };

    try {
        // Offline GitHub Pages repo games run under the in-scope mirror
        // prefix; those requests map to the repository cache.
        var repoProxy = parseRepoProxyUrl(url);
        if (repoProxy) {
            event.respondWith(handleRepoProxyRequest(request, repoProxy));
            return;
        }

        if (request.headers.get('Range')) {
            var rangePromise = handleRangeRequest(request);
            if (isGithubPagesHost(url)) {
                rangePromise = rangePromise.catch(function () {
                    return repoNotFoundResponse();
                });
            }
            event.respondWith(rangePromise);
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
                // pushed update wins; offline falls back to the cached copy
                // (including the repository cache), then to the notice page.
                event.respondWith(
                    fetch(request).then(function (response) {
                        putInCache(isGithubPagesHost(url) ? REPO_CACHE : GAMES_CACHE, request, response);
                        return response;
                    }).catch(function () {
                        return matchAnyCache(request).then(function (hit) {
                            return hit || offlineFallbackResponse();
                        });
                    })
                );
            } else if (isGithubPagesHost(url)) {
                // GitHub Pages game reached from a mirror deployment of the
                // launcher (or nested inside a cached repo game): same
                // network-first rule, backed by the repository cache.
                event.respondWith(
                    fetch(request).then(function (response) {
                        putInCache(REPO_CACHE, request, response);
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
        var externalCache = isGithubPagesHost(url) ? REPO_CACHE : GAMES_CACHE;
        if (isInScope(url)) {
            // Cover images, offline.js and anything else the site ships.
            event.respondWith(
                staleWhileRevalidate(request, SHELL_CACHE, waitUntil)
                    .catch(function () { return fetch(request); })
            );
        } else if (url.origin === SCOPE_URL.origin) {
            // Files from a repo outside this scope - most importantly the
            // assets a cached repository game asks for while running in
            // the controlled repo-game.html frame: served from the
            // repository cache first, fetched from the repo on a miss.
            event.respondWith(
                (wantsRevalidate
                    ? networkRevalidating(request, externalCache)
                    : cacheFirst(request, externalCache)
                ).catch(function () {
                    return isGithubPagesHost(url)
                        ? repoNotFoundResponse()
                        : fetch(request);
                })
            );
        } else {
            // CDN game assets (jsDelivr / githack / raw.githubusercontent /
            // fonts) and cross-origin GitHub Pages files: cache-first.
            event.respondWith(
                (wantsRevalidate
                    ? networkRevalidating(request, externalCache)
                    : cacheFirst(request, externalCache)
                ).catch(function () {
                    return isGithubPagesHost(url)
                        ? repoNotFoundResponse()
                        : fetch(request);
                })
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
            var core = ['./', 'index.html', 'offline.html', 'repo-game.html', 'offline.js', 'favicon.ico'];
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
