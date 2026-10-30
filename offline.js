/* ============================================================================
   Solus MS - Offline Mode client (offline.js)
   ============================================================================
   Loaded by index.html (Settings > Offline Mode toggle, one-time consent
   dialog, service worker registration) and by repo-game.html (the host
   page index.html routes GitHub Pages games through while Offline Mode
   is on).

   Two kinds of caching, both driven from here and served by sw.js:

   1. Runtime caching (in sw.js): the worker stores the launcher itself
      plus every file a game fetches while it loads - including everything
      the games pull from CDNs (cdn.jsdelivr.net and friends, which serve
      straight from the GitHub repos hosting the game files).

   2. Repository caching (below, for games whose wrapper page iframes a
      whole GitHub Pages site): a service worker scoped to /Solus-MS/ can
      never see that inner site's requests, so instead this file caches
      the game's entire GitHub repository up front. The repo and its
      entry point are read straight from the wrapper's iframe URL
      (https://<owner>.github.io/<repo>/<path>), the file list comes from
      the jsDelivr CDN API (GitHub API as fallback), and every file is
      downloaded from the CDN (cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/…)
      and stored under its GitHub Pages URL. Offline, repo-game.html
      serves the repo's index.html from that cache inside a frame the
      worker controls, so the game boots and loads its files locally.
      Online the real GitHub Pages game is loaded completely unchanged
      while the repository downloads in the background. No game page or
      wrapper file is modified, and no link-following crawl is involved -
      the repository's own file list is the single source of truth.

   When Offline Mode is OFF (the default) this file never registers the
   worker and the site behaves exactly as it always has.

   Turning Offline Mode off deletes ONLY the "solus-*" Cache Storage
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
    var REPO_CACHE = 'solus-repo-' + CACHE_VERSION;

    // Repository downloads made by this file carry this marker so sw.js
    // lets them straight through to the network instead of also storing a
    // second copy under the CDN URL (they are stored once, here, under
    // their GitHub Pages URL).
    var REPO_FETCH_PARAM = '__solus_repo_fetch';
    var REPO_DOWNLOAD_CONCURRENCY = 3;

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

    // All site files live flat in one directory, so the service worker's
    // URL is just "sw.js next to the current page". Built from the page URL
    // (origin absolute) so it works identically on GitHub Pages
    // (/Solus-MS/) and on the root-domain mirrors / localhost.
    function sitePath() {
        return window.location.pathname.replace(/[^/]*$/, '');
    }
    function siteFile(name) {
        return window.location.origin + sitePath() + name;
    }

    function formatBytes(bytes) {
        if (!bytes || bytes < 1024) return '0 MB';
        var mb = bytes / (1024 * 1024);
        if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
        return (mb / 1024).toFixed(2) + ' GB';
    }

    /* ---------------- service worker management ---------------- */

    function waitForWorkerActive(worker) {
        if (!worker || worker.state === 'activated') return Promise.resolve();
        return new Promise(function (resolve) {
            var done = false;
            var finish = function () {
                if (!done) { done = true; resolve(); }
            };
            try {
                worker.addEventListener('statechange', function () {
                    if (worker.state === 'activated' || worker.state === 'redundant') finish();
                });
            } catch (e) { finish(); }
            setTimeout(finish, 5000);
        });
    }

    function registerSW() {
        if (!swSupported()) return Promise.reject(new Error('Service workers are not available in this browser or context.'));
        return navigator.serviceWorker.register(siteFile('sw.js'))
            .then(function (registration) {
                // Explicitly look for a newer worker so page and worker
                // behavior roll out together instead of waiting for the
                // browser's throttled (up to 24h) background update check.
                var updated = (registration && registration.update)
                    ? registration.update().catch(function () { return null; })
                    : Promise.resolve(null);
                return updated.then(function () {
                    var candidate = registration && (registration.installing || registration.waiting);
                    return waitForWorkerActive(candidate);
                }).then(function () {
                    return navigator.serviceWorker.ready;
                });
            });
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

    // Ask the active worker to (re)cache the site's own files, with progress.
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
                // Roll the flag back so nothing believes offline is active.
                lsSet(LS_ENABLED, 'false');
                throw err;
            });
    }

    function disableOffline() {
        // Flag first, so the state is "off" even if teardown is interrupted.
        lsSet(LS_ENABLED, 'false');
        return unregisterSW().then(deleteSolusCaches);
    }


    /* ---------------- GitHub Pages repository games ----------------
       The wrappers for these games contain nothing but an iframe pointing
       at a GitHub Pages site, e.g.
           https://katsugachi.github.io/Balatro-WASM/balatro/index.html
       That one URL identifies everything needed to save the game offline:
       the owner (subdomain), the repository (first path segment) and the
       entry document (the rest). cacheRepo() downloads the repository's
       files from the jsDelivr CDN - which serves any public GitHub repo -
       and stores each one under its GitHub Pages URL. */

    function encodeRepoPath(path) {
        return String(path).split('/').filter(function (p) { return p.length; })
            .map(function (p) { return encodeURIComponent(p); }).join('/');
    }

    function decodeSegment(segment) {
        try { return decodeURIComponent(segment); } catch (e) { return segment; }
    }

    // Parse https://<owner>.github.io/<repo>/<...path> into repo parts.
    function parseGithubPagesUrl(value) {
        var url;
        try { url = new URL(value); } catch (e) { return null; }
        if (url.protocol !== 'https:' || !/\.github\.io$/i.test(url.hostname)) return null;
        var owner = url.hostname.slice(0, -'.github.io'.length);
        if (!owner || owner.indexOf('.') !== -1) return null;

        var segments = url.pathname.split('/').filter(function (p) { return p.length; })
            .map(decodeSegment);
        var repo, pathSegments, repoBasePath;
        if (!segments.length) {
            // User/organisation site: the repo is <owner>.github.io itself.
            repo = owner + '.github.io';
            pathSegments = [];
            repoBasePath = '';
        } else {
            repo = segments[0];
            pathSegments = segments.slice(1);
            repoBasePath = '/' + encodeURIComponent(repo);
        }

        var last = pathSegments[pathSegments.length - 1] || '';
        var isFile = pathSegments.length > 0 && /\.[a-z0-9]+$/i.test(last) && !/\/$/.test(url.pathname);
        var dirSegments = isFile ? pathSegments.slice(0, -1) : pathSegments;
        var indexSegments = isFile ? pathSegments : pathSegments.concat(['index.html']);

        var repoBaseUrl = 'https://' + url.hostname + repoBasePath + '/';
        return {
            input: url.href,
            hostname: url.hostname,
            owner: owner,
            repo: repo,
            repoBaseUrl: repoBaseUrl,
            dirUrl: repoBaseUrl + (dirSegments.length ? encodeRepoPath(dirSegments.join('/')) + '/' : ''),
            indexUrl: repoBaseUrl + encodeRepoPath(indexSegments.join('/')),
            indexPath: indexSegments.join('/'),
            subtreePrefix: dirSegments.length ? dirSegments.join('/') + '/' : ''
        };
    }

    function withRepoFetchMarker(urlHref) {
        try {
            var u = new URL(urlHref);
            u.searchParams.set(REPO_FETCH_PARAM, '1');
            return u.href;
        } catch (e) { return urlHref; }
    }

    function repoFetch(urlHref) {
        return fetch(withRepoFetchMarker(urlHref), { credentials: 'omit', cache: 'no-store' });
    }

    function normalizeRepoPath(name) {
        return String(name == null ? '' : name).replace(/^\/+/, '').replace(/^\.\//, '');
    }

    // Accepts every listing shape we consume: jsDelivr flat, jsDelivr
    // nested, and the GitHub git-trees response.
    function extractListingFiles(json) {
        var files = [];
        var seen = {};
        function push(path, node) {
            path = normalizeRepoPath(path);
            if (!path || /\/$/.test(path) || seen[path]) return;
            seen[path] = true;
            files.push({
                path: path,
                hash: String((node && (node.hash || node.sha)) || ''),
                size: Number(node && node.size) || 0
            });
        }
        function walk(nodes, prefix) {
            if (!Array.isArray(nodes)) return;
            nodes.forEach(function (node) {
                if (!node || typeof node !== 'object') return;
                var rawName = String(node.name || '');
                if (Array.isArray(node.files)) {
                    var dir = normalizeRepoPath(rawName);
                    walk(node.files, dir ? dir + '/' : prefix);
                } else if (node.path && node.type !== 'tree') {
                    push(node.path, node); // git trees: full path
                } else if (rawName && node.type !== 'directory' && node.type !== 'tree') {
                    push(rawName.charAt(0) === '/' || !prefix ? rawName : prefix + rawName, node);
                }
            });
        }
        if (json && Array.isArray(json.tree)) walk(json.tree, '');
        else if (json && Array.isArray(json.files)) walk(json.files, '');
        else if (Array.isArray(json)) walk(json, '');
        return files;
    }

    function listingHasTarget(files, info) {
        return files.some(function (f) { return f.path === info.indexPath; });
    }

    // Resolve which ref of the repo GitHub Pages is serving and list its
    // files. jsDelivr first (no rate limits worth worrying about), the
    // GitHub API as a fallback.
    function fetchRepoListing(info) {
        var refs = ['gh-pages', 'main', 'master'];
        var candidates = [];

        function tryJsdelivr(index) {
            if (index >= refs.length) return Promise.resolve(null);
            var ref = refs[index];
            var base = 'https://data.jsdelivr.com/v1/packages/gh/' +
                encodeURIComponent(info.owner) + '/' + encodeURIComponent(info.repo) +
                '@' + encodeURIComponent(ref);
            return repoFetch(base + '?structure=flat')
                .then(function (r) { return r && r.ok ? r.json() : null; })
                .then(function (json) {
                    var files = json ? extractListingFiles(json) : [];
                    if (files.length) {
                        var candidate = { ref: ref, source: 'jsdelivr', files: files, truncated: false };
                        if (listingHasTarget(files, info)) return candidate;
                        candidates.push(candidate);
                    }
                    return tryJsdelivr(index + 1);
                })
                .catch(function () { return tryJsdelivr(index + 1); });
        }

        function tryGithub(refList, index) {
            if (index >= refList.length) return Promise.resolve(null);
            var ref = refList[index];
            var api = 'https://api.github.com/repos/' + encodeURIComponent(info.owner) + '/' +
                encodeURIComponent(info.repo) + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1';
            return repoFetch(api)
                .then(function (r) { return r && r.ok ? r.json() : null; })
                .then(function (json) {
                    var files = json ? extractListingFiles(json) : [];
                    if (files.length) {
                        var candidate = { ref: ref, source: 'github', files: files, truncated: !!(json && json.truncated) };
                        if (listingHasTarget(files, info)) return candidate;
                        candidates.push(candidate);
                    }
                    return tryGithub(refList, index + 1);
                })
                .catch(function () { return tryGithub(refList, index + 1); });
        }

        return tryJsdelivr(0).then(function (hit) {
            if (hit) return hit;
            // Ask GitHub for the default branch, then walk candidate refs.
            return repoFetch('https://api.github.com/repos/' + encodeURIComponent(info.owner) + '/' + encodeURIComponent(info.repo))
                .then(function (r) { return r && r.ok ? r.json() : null; })
                .catch(function () { return null; })
                .then(function (meta) {
                    var refList = ['gh-pages'];
                    if (meta && meta.default_branch) refList.push(String(meta.default_branch));
                    refList.push('main', 'master');
                    refList = refList.filter(function (v, i) { return refList.indexOf(v) === i; });
                    return tryGithub(refList, 0);
                });
        }).then(function (hit) {
            if (hit) return hit;
            // No ref contained the exact entry path; use the fullest listing
            // we got - Pages may be publishing a build output folder.
            candidates.sort(function (a, b) { return b.files.length - a.files.length; });
            return candidates[0] || null;
        });
    }

    function repoManifestKey(info) {
        return 'https://solus-repo.invalid/' + encodeURIComponent(info.owner.toLowerCase()) +
            '/' + encodeURIComponent(info.repo.toLowerCase());
    }

    function readRepoManifest(cache, info) {
        return cache.match(repoManifestKey(info)).then(function (hit) {
            if (!hit) return null;
            return hit.json().catch(function () { return null; });
        }).catch(function () { return null; });
    }

    function listingFingerprint(files) {
        var h = 0x811c9dc5;
        var total = 0;
        var s = files.map(function (f) {
            total += f.size || 0;
            return f.path + '\0' + f.hash + '\0' + f.size;
        }).join('\n');
        for (var i = 0; i < s.length; i++) {
            h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
        }
        return h.toString(16) + ':' + files.length + ':' + total;
    }

    function repoFileRank(file, info) {
        if (file.path === info.indexPath) return 0;
        if (!info.subtreePrefix || file.path.indexOf(info.subtreePrefix) === 0) return 1;
        return 2;
    }

    // Entry document first, then the game's own folder, then the rest of
    // the repository - the game becomes playable offline as early as
    // possible while the whole repo still downloads behind it.
    function orderRepoFiles(files, info) {
        return files.slice().sort(function (a, b) {
            var d = repoFileRank(a, info) - repoFileRank(b, info);
            return d !== 0 ? d : (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        });
    }

    function fetchRepoFile(info, listing, file) {
        var encoded = encodeRepoPath(file.path);
        var pagesUrl = info.repoBaseUrl + encoded;
        var cdnUrl = 'https://cdn.jsdelivr.net/gh/' + encodeURIComponent(info.owner) + '/' +
            encodeURIComponent(info.repo) + '@' + encodeURIComponent(listing.ref) + '/' + encoded;
        var attempts = listing.source === 'github' ? [pagesUrl, cdnUrl] : [cdnUrl, pagesUrl];

        function attempt(index) {
            if (index >= attempts.length) return Promise.resolve(null);
            return repoFetch(attempts[index]).then(function (response) {
                if (response && response.status === 200) {
                    return { pagesUrl: pagesUrl, response: response };
                }
                return attempt(index + 1);
            }).catch(function () { return attempt(index + 1); });
        }
        return attempt(0);
    }

    /**
     * Download the game's whole repository into Cache Storage, keyed by
     * GitHub Pages URLs. Resumable: files already stored (and unchanged
     * since the last listing) are skipped, so reopening the game only
     * fetches what is missing or new.
     */
    function cacheRepo(info, onProgress) {
        if (!('caches' in window) || typeof fetch !== 'function') {
            return Promise.resolve({ ok: false, reason: 'unsupported' });
        }
        if (typeof navigator.onLine === 'boolean' && navigator.onLine === false) {
            return Promise.resolve({ ok: false, reason: 'offline' });
        }
        return caches.open(REPO_CACHE).then(function (cache) {
            return readRepoManifest(cache, info).then(function (previous) {
                // The entry document itself comes straight from GitHub
                // Pages - the exact index.html the iframe URL identifies -
                // so it is cached even if a listing API is unavailable or
                // the published output differs from the repo source.
                return repoFetch(info.indexUrl).then(function (r) {
                    if (r && r.status === 200) return cache.put(info.indexUrl, r);
                    return null;
                }).catch(function () { return null; }).then(function () {
                return fetchRepoListing(info).then(function (listing) {
                    if (!listing || !listing.files.length) {
                        return { ok: false, reason: 'no-listing' };
                    }
                    var files = orderRepoFiles(listing.files, info);
                    var fingerprint = listingFingerprint(listing.files);
                    var prevHashes = (previous && previous.fileHashes) || {};
                    var prevSameSource = !!(previous && previous.ref === listing.ref &&
                        previous.source === listing.source);
                    var done = 0, stored = 0, skipped = 0, failed = [];
                    var cursor = 0;

                    function report() {
                        if (onProgress) {
                            try {
                                onProgress({
                                    done: done, total: files.length,
                                    stored: stored, skipped: skipped, failed: failed.length
                                });
                            } catch (e) {}
                        }
                    }

                    function processOne(file) {
                        var key = info.repoBaseUrl + encodeRepoPath(file.path);
                        var unchanged = prevSameSource && !!file.hash &&
                            prevHashes[file.path] === file.hash;
                        var lookup = (unchanged || (previous && previous.fingerprint === fingerprint))
                            ? cache.match(key).catch(function () { return null; })
                            : Promise.resolve(null);
                        return lookup.then(function (hit) {
                            if (hit) { skipped++; return true; }
                            return fetchRepoFile(info, listing, file).then(function (got) {
                                if (!got) return false;
                                return cache.put(got.pagesUrl, got.response)
                                    .then(function () { stored++; return true; })
                                    .catch(function () { return false; });
                            });
                        }).then(function (success) {
                            if (!success && failed.length < 200) failed.push(file.path);
                            done++;
                            report();
                        }).catch(function () {
                            if (failed.length < 200) failed.push(file.path);
                            done++;
                            report();
                        });
                    }

                    function worker() {
                        var file = files[cursor++];
                        if (!file) return Promise.resolve();
                        return processOne(file).then(worker);
                    }

                    var workers = [];
                    for (var i = 0; i < Math.min(REPO_DOWNLOAD_CONCURRENCY, files.length); i++) {
                        workers.push(worker());
                    }
                    report();
                    return Promise.all(workers).then(function () {
                        return cache.match(info.indexUrl).then(function (indexHit) {
                            var hashes = {};
                            listing.files.forEach(function (f) { hashes[f.path] = f.hash; });
                            var manifest = {
                                version: 1,
                                owner: info.owner,
                                repo: info.repo,
                                ref: listing.ref,
                                source: listing.source,
                                fingerprint: fingerprint,
                                fileHashes: hashes,
                                totalFiles: files.length,
                                failed: failed,
                                ready: !!indexHit,
                                complete: failed.length === 0 && !listing.truncated,
                                updatedAt: Date.now()
                            };
                            return cache.put(repoManifestKey(info), new Response(
                                JSON.stringify(manifest),
                                { headers: { 'Content-Type': 'application/json' } }
                            )).catch(function () {}).then(function () {
                                return {
                                    ok: manifest.ready,
                                    complete: manifest.complete,
                                    total: files.length,
                                    stored: stored,
                                    skipped: skipped,
                                    failed: failed.length
                                };
                            });
                        });
                    });
                });
                });
            });
        }).catch(function () { return { ok: false, reason: 'error' }; });
    }

    function hasCachedRepoIndex(info) {
        if (!('caches' in window)) return Promise.resolve(false);
        return caches.open(REPO_CACHE)
            .then(function (cache) { return cache.match(info.indexUrl); })
            .then(function (hit) { return hit || caches.match(info.indexUrl); })
            .then(function (hit) { return !!hit; })
            .catch(function () { return false; });
    }

    // Offline repo games are loaded from a same-origin, in-scope mirror
    // path (handled by sw.js) instead of srcdoc. That gives the game
    // document the site's real origin - srcdoc documents report
    // location.origin as "null", which makes origin-locked webports
    // refuse to start - while keeping every mirror request under the
    // service worker's control so it can be answered from the repo cache.
    var REPO_PROXY_PREFIX = '__solus_repo/';

    function repoProxyUrl(info) {
        var suffix = '';
        try {
            var input = new URL(info.input);
            suffix = input.search + input.hash;
        } catch (e) {}
        return siteFile(
            REPO_PROXY_PREFIX +
            encodeURIComponent(info.owner) + '/' +
            encodeURIComponent(info.repo) + '/' +
            encodeRepoPath(info.indexPath)
        ) + suffix;
    }

    /**
     * Player used by repo-game.html for GitHub Pages games.
     *  online  -> load the real game untouched; cache its repo behind it
     *  offline -> load the cached repo through the service worker's
     *             in-scope mirror path, so the game's index.html and all
     *             of its files resolve to the local repository cache
     */
    function playRepoGame(options) {
        options = options || {};
        var iframe = options.iframe;
        var info = parseGithubPagesUrl(options.pagesUrl);
        if (!iframe || !info) {
            if (options.onFallback) options.onFallback();
            return Promise.resolve(false);
        }

        var progressEl = options.progressEl || null;
        function setProgress(doneCount, total, active) {
            if (progressEl) {
                var pct = total ? Math.round((doneCount / total) * 100) : 0;
                progressEl.style.width = pct + '%';
                progressEl.classList.toggle('active', !!active);
            }
            if (options.onProgress) {
                try { options.onProgress({ done: doneCount, total: total }); } catch (e) {}
            }
        }

        if (!isEnabled() || !isAccepted() || !swSupported()) {
            iframe.src = info.input;
            return Promise.resolve(false);
        }
        requestPersistence();

        var offlineNow = (typeof navigator.onLine === 'boolean' && navigator.onLine === false);
        if (!offlineNow) {
            iframe.src = info.input;
            var begin = function () {
                registerSW().catch(function () {});
                cacheRepo(info, function (p) {
                    setProgress(p.done, p.total, p.done < p.total);
                    if (p.done >= p.total) {
                        setTimeout(function () { setProgress(p.done, p.total, false); }, 600);
                    }
                }).catch(function () { setProgress(0, 0, false); });
            };
            // The game gets the network first; the repo download follows.
            if ('requestIdleCallback' in window) {
                window.requestIdleCallback(begin, { timeout: 4000 });
            } else {
                setTimeout(begin, 2000);
            }
            return Promise.resolve(true);
        }

        return registerSW().catch(function () { return null; })
            .then(function () { return hasCachedRepoIndex(info); })
            .then(function (cached) {
                iframe.removeAttribute('srcdoc');
                if (cached) {
                    iframe.src = repoProxyUrl(info);
                    return true;
                }
                iframe.src = siteFile('offline.html') + '?reason=game';
                return false;
            })
            .catch(function () {
                try { iframe.src = siteFile('offline.html') + '?reason=game'; } catch (e) {}
                return false;
            });
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
            ? Promise.all([SHELL_CACHE, GAMES_CACHE, REPO_CACHE].map(function (name) {
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
        if (!toggle) return;

        var modal = document.getElementById('offline-confirm-modal');
        var acceptBtn = document.getElementById('offline-confirm-accept');
        var cancelBtn = document.getElementById('offline-confirm-cancel');

        if (!swSupported()) {
            toggle.checked = false;
            toggle.disabled = true;
            setOfflineStatus('Offline Mode is not available in this browser or context.');
            refreshOfflineInfo();
            return;
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
    }

    /* ---------------- public surface + boot ---------------- */

    var api = {
        isEnabled: isEnabled,
        syncFromStorage: syncFromStorage,
        refreshInfo: refreshOfflineInfo,
        playRepoGame: playRepoGame,
        // Pure helpers exposed for automated tests; harmless in production.
        _internal: {
            formatBytes: formatBytes,
            sitePath: sitePath,
            parseGithubPagesUrl: parseGithubPagesUrl,
            extractListingFiles: extractListingFiles,
            repoProxyUrl: repoProxyUrl,
            hasCachedRepoIndex: hasCachedRepoIndex,
            orderRepoFiles: orderRepoFiles,
            listingFingerprint: listingFingerprint,
            cacheRepo: cacheRepo
        }
    };
    try { window.SolusOffline = api; } catch (e) {}

    function boot() {
        try { initLauncher(); } catch (e) { /* never break the launcher */ }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
