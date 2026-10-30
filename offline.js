/* ============================================================================
   Solus MS - Offline Mode client (offline.js)
   ============================================================================
   Loaded only by index.html. Wires the Settings > Offline Mode toggle, the
   one-time consent dialog, and registration of the service worker (sw.js).

   All actual caching lives in sw.js: when Offline Mode is on, the worker
   stores the launcher itself plus every file a game fetches while it loads
   - including everything the games pull from CDNs (cdn.jsdelivr.net and
   friends, which serve straight from the GitHub repos hosting the game
   files). Nothing is crawled or pre-downloaded beyond the site's own
   files; a game's files are cached simply by playing it once online, and
   the game's own loading code is never touched.

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

    /* ---------------- launcher (index.html) settings UI ---------------- */

    function refreshOfflineInfo() {
        var infoEl = document.getElementById('offline-storage-info');
        if (!infoEl) return;
        if (!isEnabled()) {
            infoEl.textContent = 'Nothing is cached while Offline Mode is off.';
            return;
        }
        var filesPromise = ('caches' in window)
            ? Promise.all([SHELL_CACHE, GAMES_CACHE].map(function (name) {
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
        // Pure helper exposed for automated tests; harmless in production.
        _internal: { formatBytes: formatBytes, sitePath: sitePath }
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
