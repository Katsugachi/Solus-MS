/* ============================================================================
   Solus MS - Offline Mode client (offline.js)
   ============================================================================
   Loaded by:
   - index.html        (Settings toggle, one-time consent dialog, SW setup)
   - every game page   (via a 1-line gated loader: inert unless enabled)
   - offline-play.html (host for the two library entries whose URL points
                        straight at a same-origin external game)

   When Offline Mode is OFF (the default) this file does nothing at all on
   game pages and never registers the service worker anywhere, so the site
   behaves exactly as it did before Offline Mode existed.

   How offline play works, per game loading pattern:

   A. Games whose page pulls files straight from a CDN (a <base> tag or a
      loader that fetches from cdn.jsdelivr.net / githack / etc.):
      The service worker sees every request those pages make and stores the
      responses. Nothing else is needed - play once online, play offline
      forever after. This file's only job here is registering the worker.

   B. Games whose page iframes a whole other same-origin site
      (balatro.html -> katsugachi.github.io/Balatro-WASM/...):
      Service workers cannot control pages outside their scope
      (/Solus-MS/), so the worker cannot see that inner game's traffic.
      Instead, while you play online, this file MIRRORS the game into Cache
      Storage: it crawls the game's entry page and asset graph, and keeps
      harvesting the exact list of files the running game fetches (readable
      from the iframe's performance timeline because it is same-origin).
      When the wrapper page is opened with no connection, the mirrored
      entry page is replayed inside a srcdoc frame. A srcdoc frame inherits
      this page's origin AND its service worker, so every file the game
      asks for is answered from the mirror by sw.js - with the game's own
      absolute URLs preserved via an injected <base> tag. Because the
      origin is unchanged, the game sees the exact same localStorage /
      IndexedDB as it does online: progress carries over seamlessly.

      Cross-origin iframed games (third-party hosts) can be neither
      mirrored (their files can't be read) nor replayed (it would move
      their saves to a different origin), so they stay online-only and get
      a friendly notice when opened offline. Online, all of this is
      invisible: the iframe still points at the real game, untouched.

   Turning Offline Mode off deletes ONLY the three "solus-*" Cache Storage
   buckets and unregisters the worker. localStorage, IndexedDB, custom
   games, stats and every save file are never touched.
   ============================================================================ */

(function () {
    'use strict';

    var LS_ENABLED = 'solus_offline';          // 'true' | 'false' (absent = false)
    var LS_ACCEPTED = 'solus_offlineAccepted'; // 'true' once the consent dialog is accepted

    // Must match sw.js - bump together with CACHE_VERSION there.
    var CACHE_VERSION = 'v1';
    var SHELL_CACHE = 'solus-shell-' + CACHE_VERSION;
    var GAMES_CACHE = 'solus-games-' + CACHE_VERSION;
    var MIRROR_CACHE = 'solus-mirror-' + CACHE_VERSION;

    var MIRROR_MAX_FILES = 900;       // per crawl session, generous but bounded
    var MIRROR_MAX_TEXT_BYTES = 4 * 1024 * 1024; // only regex-scan text up to 4MB
    var TEXT_EXTS = ['.js', '.css', '.json', '.html', '.htm', '.xml', '.txt', '.wasm.map'];

    /* ---------------- tiny safe helpers ---------------- */

    function lsGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function lsSet(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) {}
    }
    function isEnabled() { return lsGet(LS_ENABLED) === 'true'; }
    function isAccepted() { return lsGet(LS_ACCEPTED) === 'true'; }
    function swSupported() {
        return 'serviceWorker' in navigator && 'caches' in window &&
            (window.isSecureContext !== false);
    }

    // All site files live flat in one directory, so the scope path is just
    // "the directory of the current page". Computed from the URL (never
    // from <base>, which game pages point at CDNs) and origin absolute, so
    // it survives every deployment: /Solus-MS/ on GitHub Pages, / on the
    // Vercel/Netlify/Pages mirrors and on localhost.
    function sitePath() {
        return window.location.pathname.replace(/[^/]*$/, '');
    }
    function siteFile(name) {
        return window.location.origin + sitePath() + name;
    }

    function parseUrl(maybeUrl, base) {
        try { return new URL(maybeUrl, base || window.location.href); } catch (e) { return null; }
    }
    function isInScope(url) {
        return !!url && url.origin === window.location.origin &&
            url.pathname.indexOf(sitePath()) === 0;
    }
    function isExternalSameOrigin(url) {
        return !!url && url.origin === window.location.origin && !isInScope(url);
    }
    function formatBytes(bytes) {
        if (!bytes || bytes < 1024) return '0 MB';
        var mb = bytes / (1024 * 1024);
        if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
        return (mb / 1024).toFixed(2) + ' GB';
    }

    /* ---------------- service worker management ---------------- */

    function registerSW() {
        if (!swSupported()) return Promise.reject(new Error('Service workers are not available in this browser or context.'));
        return navigator.serviceWorker.register(siteFile('sw.js'))
            .then(function () { return navigator.serviceWorker.ready; });
    }

    function unregisterSW() {
        if (!('serviceWorker' in navigator)) return Promise.resolve();
        var scope = siteFile('');
        return navigator.serviceWorker.getRegistrations().then(function (regs) {
            return Promise.all(regs.map(function (reg) {
                if (reg.scope === scope || reg.scope.indexOf(scope) === 0) {
                    return reg.unregister().catch(function () {});
                }
                return null;
            }));
        }).catch(function () {});
    }

    function deleteSolusCaches() {
        if (!('caches' in window)) return Promise.resolve();
        return caches.keys().then(function (names) {
            return Promise.all(names.map(function (name) {
                if (name.indexOf('solus-') === 0) return caches.delete(name).catch(function () {});
                return null;
            }));
        }).catch(function () {});
    }

    // Ask the active worker to (re)cache the whole site shell, with progress.
    function precacheShell(onProgress) {
        return navigator.serviceWorker.ready.then(function (reg) {
            var target = (navigator.serviceWorker.controller) || reg.active || reg.waiting || reg.installing;
            if (!target) return null;
            return new Promise(function (resolve) {
                var settled = false;
                var finish = function (result) {
                    if (!settled) { settled = true; resolve(result); }
                };
                try {
                    var channel = new MessageChannel();
                    channel.port1.onmessage = function (event) {
                        var data = event.data || {};
                        if (data.type === 'SOLUS_PRECACHE_PROGRESS' && onProgress) {
                            onProgress(data.done, data.total);
                        } else if (data.type === 'SOLUS_PRECACHE_DONE') {
                            finish(data);
                        }
                    };
                    target.postMessage({ type: 'SOLUS_PRECACHE_SHELL' }, [channel.port2]);
                } catch (e) { finish(null); }
                // Never hang the settings UI on a lost message.
                setTimeout(function () { finish(null); }, 120000);
            });
        }).catch(function () { return null; });
    }

    function requestPersistence() {
        try {
            if (navigator.storage && navigator.storage.persist) {
                navigator.storage.persisted().then(function (persisted) {
                    if (!persisted) return navigator.storage.persist();
                }).catch(function () {});
            }
        } catch (e) {}
    }

    function enableOffline(onProgress) {
        lsSet(LS_ENABLED, 'true');
        return registerSW()
            .then(function () { return precacheShell(onProgress); })
            .then(function () { requestPersistence(); })
            .catch(function (err) {
                // Roll the flag back so no page believes offline is active.
                lsSet(LS_ENABLED, 'false');
                throw err;
            });
    }

    function disableOffline() {
        // Flag first: any game opened from this moment stays fully inert.
        lsSet(LS_ENABLED, 'false');
        return unregisterSW().then(deleteSolusCaches);
    }

    /**
     * Library launch hook (called from index.html's createGameCard).
     * Same-origin games linked directly by absolute URL (BG2, Eden) have no
     * wrapper page for this file to live in, so when Offline Mode is on
     * they are routed through offline-play.html - a wrapper that behaves
     * identically online and replays the mirror when offline. Everything
     * else (relative pages, blob: custom games, cross-origin URLs) is
     * returned completely unchanged.
     */
    function rewriteLaunchUrl(launchUrl, isCustom) {
        try {
            if (isCustom || !isEnabled()) return launchUrl;
            var url = parseUrl(launchUrl);
            if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return launchUrl;
            if (!isExternalSameOrigin(url)) return launchUrl;
            return 'offline-play.html?u=' + encodeURIComponent(url.href);
        } catch (e) { return launchUrl; }
    }

    /* ---------------- mirroring (pattern B, while online) ---------------- */

    function cacheNameFor(url) {
        return url.origin === window.location.origin ? MIRROR_CACHE : GAMES_CACHE;
    }

    function alreadyCached(urlHref) {
        return caches.match(urlHref).then(function (hit) { return !!hit; })
            .catch(function () { return false; });
    }

    function storeResponse(urlHref, response) {
        if (!response || (response.status !== 200 && response.status !== 0)) return Promise.resolve();
        var url = parseUrl(urlHref);
        if (!url) return Promise.resolve();
        var copy;
        try { copy = response.clone(); } catch (e) { return Promise.resolve(); }
        return caches.open(cacheNameFor(url))
            .then(function (cache) { return cache.put(urlHref, copy); })
            .catch(function () {});
    }

    // Pull asset-looking references out of JS/CSS/JSON/HTML text. Deliberately
    // conservative: only quoted strings ending in a known asset extension.
    var ASSET_REF_RE = /["'(]((?:https?:)?\/\/[^"'\s]+|[^"'\s]+?\.(?:wasm|data|mem|js|css|json|png|jpe?g|gif|webp|svg|ico|mp3|ogg|wav|mp4|webm|ttf|otf|woff2?|unityweb|symbols\.json)(?:\?[^"'\s]*)?)["')]/gi;

    function extractAssetUrls(text, baseUrl) {
        var out = [];
        var seen = {};
        if (!text) return out;
        var slice = text.length > MIRROR_MAX_TEXT_BYTES ? text.slice(0, MIRROR_MAX_TEXT_BYTES) : text;
        var m;
        ASSET_REF_RE.lastIndex = 0;
        while ((m = ASSET_REF_RE.exec(slice)) !== null) {
            var ref = m[1];
            if (!ref || ref.indexOf('data:') === 0 || ref.indexOf('blob:') === 0) continue;
            var abs = parseUrl(ref, baseUrl);
            if (!abs || (abs.protocol !== 'http:' && abs.protocol !== 'https:')) continue;
            if (!seen[abs.href]) { seen[abs.href] = true; out.push(abs.href); }
        }
        return out;
    }

    function extractHtmlUrls(html, pageUrl) {
        var urls = [];
        try {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var baseEl = doc.querySelector('base[href]');
            var base = baseEl ? (parseUrl(baseEl.getAttribute('href'), pageUrl) || {}).href : pageUrl;
            var nodes = doc.querySelectorAll('script[src], link[href], img[src], iframe[src], source[src], video[src], audio[src], embed[src], input[src]');
            Array.prototype.forEach.call(nodes, function (node) {
                var ref = node.getAttribute('src') || node.getAttribute('href');
                var abs = parseUrl(ref, base || pageUrl);
                if (abs && (abs.protocol === 'http:' || abs.protocol === 'https:')) urls.push(abs.href);
            });
            // Inline config objects (Unity dataUrl/frameworkUrl/codeUrl etc.)
            extractAssetUrls(html, base || pageUrl).forEach(function (u) { urls.push(u); });
        } catch (e) {}
        return urls;
    }

    function isTextAsset(url) {
        var path = url.pathname.toLowerCase();
        return TEXT_EXTS.some(function (ext) { return path.slice(-ext.length) === ext; });
    }

    // Unity WebGL builds ship four siblings; if the loader is queued, queue
    // the rest under their conventional names too (a 404 just gets skipped).
    function unitySiblings(urlHref) {
        var out = [];
        var match = /^(.*\/)([^/]+)\.loader\.js(\?.*)?$/.exec(urlHref);
        if (match) {
            var stem = match[1] + match[2];
            out.push(stem + '.framework.js', stem + '.wasm', stem + '.data',
                     stem + '.framework.js.unityweb', stem + '.wasm.unityweb', stem + '.data.unityweb');
        }
        return out;
    }

    /**
     * Crawl the iframed game's entry document + asset graph into Cache
     * Storage. Runs quietly in the background while the game is being
     * played online. Text assets are revalidated every visit so a game
     * update is picked up; large binaries are only fetched once.
     */
    function crawlMirror(startUrlHref) {
        if (!('caches' in window)) return Promise.resolve();
        var visited = {};
        var queue = [{ url: startUrlHref, depth: 0, isEntry: true }];
        var stored = 0;

        function enqueue(urlHref, depth) {
            if (!urlHref || visited[urlHref] || queue.length > MIRROR_MAX_FILES) return;
            visited[urlHref] = true;
            queue.push({ url: urlHref, depth: depth, isEntry: false });
        }

        function process(item) {
            var url = parseUrl(item.url);
            if (!url) return Promise.resolve();
            var isText = item.isEntry || isTextAsset(url);
            var needFetch = isText
                ? Promise.resolve(true)                       // revalidate text each visit
                : alreadyCached(item.url).then(function (hit) { return !hit; });
            return needFetch.then(function (go) {
                if (!go || stored > MIRROR_MAX_FILES) return null;
                return fetch(item.url, {
                    credentials: url.origin === window.location.origin ? 'same-origin' : 'omit',
                    cache: isText ? 'no-cache' : 'default'
                }).then(function (response) {
                    if (!response || response.status !== 200) return null;
                    stored++;
                    var put = storeResponse(item.url, response);
                    var contentType = (response.headers.get('Content-Type') || '').toLowerCase();
                    var looksHtml = item.isEntry || contentType.indexOf('html') !== -1;
                    var looksText = isText || contentType.indexOf('javascript') !== -1 ||
                        contentType.indexOf('json') !== -1 || contentType.indexOf('css') !== -1 ||
                        contentType.indexOf('text') !== -1;
                    if (!looksHtml && !looksText) return put;
                    var len = parseInt(response.headers.get('Content-Length') || '0', 10);
                    if (len && len > MIRROR_MAX_TEXT_BYTES) return put;
                    return response.clone().text().then(function (text) {
                        var found = looksHtml
                            ? extractHtmlUrls(text, item.url)
                            : extractAssetUrls(text, item.url);
                        if (item.depth < 2) {
                            found.forEach(function (u) {
                                enqueue(u, item.depth + 1);
                                unitySiblings(u).forEach(function (s) { enqueue(s, item.depth + 1); });
                            });
                        }
                        return put;
                    }).catch(function () { return put; });
                }).catch(function () { return null; });
            });
        }

        // Small worker pool: parallel enough to be quick, gentle enough to
        // never compete with the game that is loading in the foreground.
        var workers = [];
        for (var i = 0; i < 4; i++) {
            workers.push((function worker() {
                var item = queue.shift();
                if (!item) return Promise.resolve();
                return process(item).then(worker);
            })());
        }
        return Promise.all(workers).catch(function () {});
    }

    /**
     * Keep sweeping the running game's performance timeline: any file the
     * game actually fetched (streaming assets, level data, audio banks -
     * things a static crawl cannot predict) gets mirrored too.
     */
    function startHarvest(iframe, entryUrlHref) {
        var seen = {};
        seen[entryUrlHref] = true;

        function sweep() {
            var win;
            try { win = iframe.contentWindow; } catch (e) { return; }
            if (!win) return;
            try {
                if (win.performance && win.performance.setResourceTimingBufferSize) {
                    try { win.performance.setResourceTimingBufferSize(10000); } catch (e) {}
                }
                var entries = win.performance.getEntriesByType('resource');
                entries.forEach(function (entry) {
                    var href = entry && entry.name;
                    if (!href || seen[href]) return;
                    seen[href] = true;
                    var url = parseUrl(href);
                    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return;
                    alreadyCached(href).then(function (hit) {
                        if (hit) return null;
                        return fetch(href, {
                            credentials: url.origin === window.location.origin ? 'same-origin' : 'omit'
                        }).then(function (response) { return storeResponse(href, response); })
                          .catch(function () {});
                    });
                });
                // The document the game finally settled on (after redirects)
                var docHref = win.location && win.location.href;
                if (docHref && !seen[docHref] && docHref.indexOf('http') === 0) {
                    seen[docHref] = true;
                    fetch(docHref, { credentials: 'same-origin', cache: 'no-cache' })
                        .then(function (response) { return storeResponse(docHref, response); })
                        .catch(function () {});
                }
            } catch (e) {
                // Cross-origin frame: its timeline is off-limits, stop trying.
                stop();
            }
        }

        var timer = setInterval(sweep, 4000);
        function stop() { clearInterval(timer); }
        window.addEventListener('pagehide', stop);
        setTimeout(sweep, 1500);
    }

    /* ---------------- offline replay (pattern B) ---------------- */

    function mirroredHtmlCandidates(targetUrl) {
        var list = [targetUrl.href];
        var path = targetUrl.pathname;
        if (/\/$/.test(path)) {
            list.push(targetUrl.href + 'index.html');
        } else if (/\/index\.html?$/i.test(path)) {
            list.push(targetUrl.href.replace(/index\.html?$/i, ''));
        } else if (!/\.[a-z0-9]+$/i.test(path)) {
            list.push(targetUrl.href + '/');
            list.push(targetUrl.href + '/index.html');
        }
        return list;
    }

    function getMirroredHtml(targetUrl) {
        if (!('caches' in window)) return Promise.resolve(null);
        var candidates = mirroredHtmlCandidates(targetUrl);
        var chain = Promise.resolve(null);
        candidates.forEach(function (candidate) {
            chain = chain.then(function (found) {
                if (found) return found;
                return caches.open(MIRROR_CACHE)
                    .then(function (cache) { return cache.match(candidate); })
                    .then(function (hit) { return hit || null; })
                    .catch(function () { return null; });
            });
        });
        return chain.then(function (response) {
            if (!response) return null;
            return response.text().then(function (text) {
                return text && text.length ? text : null;
            }).catch(function () { return null; });
        });
    }

    /**
     * Point every relative URL in the mirrored document back at the game's
     * real location, so the service worker can answer from the mirror.
     */
    function injectBase(html, targetUrl) {
        if (/<base\s[^>]*href\s*=/i.test(html)) return html; // game set its own
        var baseHref = targetUrl.href.replace(/[^/]*(\?.*)?$/, '');
        if (!/\/$/.test(baseHref)) baseHref += '/';
        var tag = '<base href="' + baseHref.replace(/"/g, '%22') + '">';
        if (/<head[^>]*>/i.test(html)) {
            return html.replace(/<head[^>]*>/i, function (m) { return m + tag; });
        }
        return tag + html;
    }

    function showOfflineNotice(iframe) {
        try {
            iframe.removeAttribute('srcdoc');
            iframe.src = siteFile('offline.html') + '?reason=game';
        } catch (e) {}
    }

    /**
     * Unified player for an external same-origin game inside `iframe`.
     *  online  -> point the frame at the real game (wrapper pages already
     *             do this; we only add background mirroring)
     *  offline -> replay the mirror via srcdoc, or show the notice page
     */
    function playExternal(iframe, targetUrlHref, opts) {
        opts = opts || {};
        var target = parseUrl(targetUrlHref);
        if (!iframe || !target) return;

        if (!isEnabled() || !swSupported()) {
            if (opts.setSrcWhenOnline) iframe.src = target.href;
            return;
        }
        registerSW().catch(function () {});

        var offlineNow = (typeof navigator.onLine === 'boolean' && navigator.onLine === false);
        if (offlineNow) {
            getMirroredHtml(target).then(function (html) {
                if (html) {
                    try {
                        iframe.removeAttribute('src');
                        iframe.srcdoc = injectBase(html, target);
                    } catch (e) { showOfflineNotice(iframe); }
                } else {
                    showOfflineNotice(iframe);
                }
            }).catch(function () { showOfflineNotice(iframe); });
            return;
        }

        if (opts.setSrcWhenOnline && iframe.getAttribute('src') !== target.href) {
            iframe.src = target.href;
        }
        // Let the game win the bandwidth race for its first paint, then
        // mirror in the background.
        var begin = function () {
            crawlMirror(target.href);
            startHarvest(iframe, target.href);
        };
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(begin, { timeout: 4000 });
        } else {
            setTimeout(begin, 2000);
        }
    }

    /* ---------------- game-page auto behaviour ---------------- */

    function initGamePage() {
        if (!isEnabled()) return;
        registerSW().catch(function () {});

        var iframe = document.querySelector('#fullscreen-iframe') ||
                     document.querySelector('iframe[src]');
        if (!iframe) return; // CDN-direct game: SW runtime-caching is enough

        var src = iframe.getAttribute('src') || iframe.src;
        var target = parseUrl(src);
        if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) return;

        if (isExternalSameOrigin(target)) {
            playExternal(iframe, target.href, { setSrcWhenOnline: false });
        } else if (target.origin !== window.location.origin) {
            // Cross-origin host: online-only by platform rules. Swap the
            // browser's error page for our themed notice when offline.
            if (typeof navigator.onLine === 'boolean' && navigator.onLine === false) {
                showOfflineNotice(iframe);
            }
        }
        // In-scope iframes need nothing special.
    }

    /* ---------------- launcher (index.html) settings UI ---------------- */

    function refreshOfflineInfo() {
        var infoEl = document.getElementById('offline-storage-info');
        if (!infoEl) return;
        if (!isEnabled()) {
            infoEl.textContent = 'Nothing is cached while Offline Mode is off.';
            return;
        }
        var filesPromise = ('caches' in window)
            ? Promise.all([SHELL_CACHE, GAMES_CACHE, MIRROR_CACHE].map(function (name) {
                return caches.open(name).then(function (c) { return c.keys(); })
                    .then(function (keys) { return keys.length; }).catch(function () { return 0; });
            })).then(function (counts) {
                return counts.reduce(function (a, b) { return a + b; }, 0);
            })
            : Promise.resolve(0);
        var bytesPromise = (navigator.storage && navigator.storage.estimate)
            ? navigator.storage.estimate().then(function (est) {
                if (est && est.usageDetails && typeof est.usageDetails.caches === 'number') {
                    return est.usageDetails.caches;
                }
                return (est && est.usage) || 0;
            }).catch(function () { return 0; })
            : Promise.resolve(0);
        Promise.all([filesPromise, bytesPromise]).then(function (vals) {
            var files = vals[0], bytes = vals[1];
            infoEl.textContent = files + (files === 1 ? ' file' : ' files') +
                ' cached' + (bytes ? ' · about ' + formatBytes(bytes) + ' on this device' : '') +
                '. Play a game once online and it becomes available offline.';
        }).catch(function () {});
    }

    function setOfflineStatus(text) {
        var el = document.getElementById('offline-status');
        if (el) el.textContent = text || '';
    }

    var syncing = false;
    function syncFromStorage() {
        var toggle = document.getElementById('offline-mode-toggle');
        if (syncing) return;
        syncing = true;
        try {
            var enabled = isEnabled() && isAccepted();
            if (toggle) toggle.checked = enabled;
            if (enabled && swSupported()) {
                registerSW().catch(function () {
                    if (toggle) toggle.checked = false;
                    lsSet(LS_ENABLED, 'false');
                    setOfflineStatus('Offline Mode is not available in this browser or context.');
                });
            } else if (!isEnabled()) {
                // Another tab (or an import) turned it off: tear down here too.
                unregisterSW().then(deleteSolusCaches).catch(function () {});
            }
            refreshOfflineInfo();
        } finally {
            syncing = false;
        }
    }

    function initLauncher() {
        var toggle = document.getElementById('offline-mode-toggle');
        if (!toggle) return false;

        var modal = document.getElementById('offline-confirm-modal');
        var acceptBtn = document.getElementById('offline-confirm-accept');
        var cancelBtn = document.getElementById('offline-confirm-cancel');

        if (!swSupported()) {
            toggle.checked = false;
            toggle.disabled = true;
            setOfflineStatus('Offline Mode is not available in this browser or context.');
            refreshOfflineInfo();
            return true;
        }

        function openModal() {
            if (!modal) return;
            modal.classList.add('active');
            // Default focus on Cancel: enabling must be a deliberate click.
            if (cancelBtn) cancelBtn.focus();
        }
        function closeModal() {
            if (modal) modal.classList.remove('active');
        }

        function doEnable() {
            toggle.checked = true;
            setOfflineStatus('Preparing offline cache…');
            enableOffline(function (done, total) {
                setOfflineStatus('Caching Solus MS for offline use… ' + done + '/' + total);
            }).then(function () {
                setOfflineStatus('Offline Mode is on. Games you play will be saved for offline use.');
                refreshOfflineInfo();
            }).catch(function () {
                toggle.checked = false;
                setOfflineStatus('Could not turn on Offline Mode in this browser or context. Nothing was changed.');
                refreshOfflineInfo();
            });
        }

        toggle.addEventListener('change', function () {
            if (toggle.checked) {
                if (!isAccepted()) {
                    // One-time consent first; the switch stays off until the
                    // user explicitly accepts in the dialog.
                    toggle.checked = false;
                    openModal();
                    return;
                }
                doEnable();
            } else {
                setOfflineStatus('Removing cached game files…');
                disableOffline().then(function () {
                    setOfflineStatus('Offline Mode is off. Cached game files were removed - your saves and progress were not touched. Games will cache again next time you play them with Offline Mode on.');
                    refreshOfflineInfo();
                });
            }
        });

        if (acceptBtn) {
            acceptBtn.addEventListener('click', function () {
                lsSet(LS_ACCEPTED, 'true');
                closeModal();
                doEnable();
            });
        }
        if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
        if (modal) {
            modal.addEventListener('click', function (e) {
                if (e.target === modal) closeModal();
            });
            // Keep Escape for the dialog itself while it is open, so it
            // can't also trigger the panic key underneath.
            modal.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeModal();
                }
            });
        }

        // Keep the storage line fresh whenever Settings is opened.
        ['nav-settings', 'mnav-settings'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('click', refreshOfflineInfo);
        });

        window.addEventListener('storage', function (e) {
            if (e.key === LS_ENABLED || e.key === LS_ACCEPTED) syncFromStorage();
        });

        syncFromStorage();
        return true;
    }

    /* ---------------- public surface + boot ---------------- */

    var api = {
        isEnabled: isEnabled,
        rewriteLaunchUrl: rewriteLaunchUrl,
        playExternal: playExternal,
        syncFromStorage: syncFromStorage,
        refreshInfo: refreshOfflineInfo,
        // Pure helpers exposed for automated tests; harmless in production.
        _internal: {
            extractAssetUrls: extractAssetUrls,
            extractHtmlUrls: extractHtmlUrls,
            injectBase: injectBase,
            mirroredHtmlCandidates: mirroredHtmlCandidates,
            isInScope: isInScope,
            isExternalSameOrigin: isExternalSameOrigin,
            sitePath: sitePath,
            formatBytes: formatBytes
        }
    };
    try { window.SolusOffline = api; } catch (e) {}

    function boot() {
        try {
            if (!initLauncher()) initGamePage();
        } catch (e) { /* never break the host page */ }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
