const scriptUrl = new URL(self.location.href);
const serviceWorkerVersion = scriptUrl.searchParams.get('v') || 'dev';
const cachePrefix = 'zulors';
const shellCacheName = `${cachePrefix}-shell-${serviceWorkerVersion}`;
const mediaCacheName = `${cachePrefix}-media-v1`;
const navigationShellRequest = new Request('/__zulors_cached_navigation_shell__');
const mediaMetaRequest = new Request('/__zulors_media_cache_meta__');
const navigationTimeoutMs = 850;
const mediaCacheMaxBytes = 80 * 1024 * 1024;
const mediaCacheMaxEntries = 160;
const mediaCacheMaxSingleBytes = 25 * 1024 * 1024;
const trustedMediaOrigin = 'https://media.zulors.com';
let reelCachePriorityUrls = new Map();
let hlsDescendantPriorityUrls = new Map();

const appShellManifestEntries = [
    'resources/js/spa/apps/desktop/bootstrap/application.js',
    'resources/js/spa/apps/mobile/bootstrap/application.js',
    'resources/css/spa/apps/desktop/main.css',
    'resources/css/spa/apps/mobile/main.css',
];

const homeDynamicImportPattern = /resources\/js\/spa\/apps\/(desktop|mobile)\/views\/home\//;

const wait = (timeout) => {
    return new Promise((resolve) => {
        setTimeout(resolve, timeout);
    });
};

const sameOrigin = (url) => {
    return url.origin === self.location.origin;
};

const normalizeAssetUrl = (assetPath) => {
    if(! assetPath) {
        return null;
    }

    if(/^https?:\/\//i.test(assetPath)) {
        return assetPath;
    }

    return `/build/${String(assetPath).replace(/^\/+/, '')}`;
};

const addManifestEntryAssets = (manifest, entryKey, assets, visited) => {
    if(! entryKey || visited.has(entryKey)) {
        return;
    }

    const entry = manifest[entryKey];

    if(! entry) {
        return;
    }

    visited.add(entryKey);

    [
        entry.file,
        ...(entry.css || []),
        ...(entry.assets || []),
    ].forEach((assetPath) => {
        const assetUrl = normalizeAssetUrl(assetPath);

        if(assetUrl) {
            assets.add(assetUrl);
        }
    });

    (entry.imports || []).forEach((importKey) => {
        addManifestEntryAssets(manifest, importKey, assets, visited);
    });

    (entry.dynamicImports || []).forEach((importKey) => {
        if(homeDynamicImportPattern.test(importKey)) {
            addManifestEntryAssets(manifest, importKey, assets, visited);
        }
    });
};

const collectAppShellAssets = async () => {
    const assets = new Set([
        '/pwa/manifest.json',
    ]);

    try {
        const response = await fetch(`/build/manifest.json?sw=${Date.now()}`, {
            cache: 'no-store',
            credentials: 'same-origin',
        });

        if(! response.ok) {
            return assets;
        }

        const manifest = await response.json();
        const visited = new Set();

        appShellManifestEntries.forEach((entryKey) => {
            addManifestEntryAssets(manifest, entryKey, assets, visited);
        });
    }
    catch (error) {
        //
    }

    return assets;
};

const precacheAppShell = async () => {
    const cache = await caches.open(shellCacheName);
    const assets = await collectAppShellAssets();

    await Promise.allSettled(Array.from(assets).map((assetUrl) => {
        return cache.add(new Request(assetUrl, {
            cache: 'reload',
            credentials: 'same-origin',
        }));
    }));
};

const deleteOldCaches = async () => {
    const allowedCaches = new Set([
        shellCacheName,
        mediaCacheName,
    ]);
    const cacheNames = await caches.keys();

    await Promise.all(cacheNames.map((cacheName) => {
        if(cacheName.startsWith(`${cachePrefix}-`) && ! allowedCaches.has(cacheName)) {
            return caches.delete(cacheName);
        }

        return Promise.resolve(false);
    }));
};

const isApiRequest = (url) => {
    return sameOrigin(url) && url.pathname.startsWith('/api/');
};

const isBuildAssetRequest = (url) => {
    return sameOrigin(url) && (
        url.pathname.startsWith('/build/assets/') ||
        url.pathname === '/build/manifest.json'
    );
};

const isPwaStaticRequest = (url) => {
    return sameOrigin(url) && (
        url.pathname === '/pwa/manifest.json' ||
        url.pathname.startsWith('/pwa/icons/') ||
        url.pathname.startsWith('/assets/logos/') ||
        url.pathname === '/favicon.ico'
    );
};

const isMediaRequest = (request, url) => {
    if(['image', 'video', 'audio'].includes(request.destination)) {
        return true;
    }

    return /\.(avif|gif|jpe?g|png|svg|webp|mp4|m4v|webm|mov|m3u8|ts|m4s|mp3|ogg|wav)$/i.test(url.pathname);
};

const mediaPriorityForUrl = (url) => Math.max(
    Number(reelCachePriorityUrls.get(url) || 0),
    Number(hlsDescendantPriorityUrls.get(url) || 0),
);

const normalizeCachePriorityUrl = (value) => {
    try {
        const url = new URL(String(value || ''), self.location.origin);
        if(! ['http:', 'https:'].includes(url.protocol)
            || (url.origin !== self.location.origin && url.origin !== trustedMediaOrigin)
            || url.username || url.password) {
            return null;
        }
        return url.href;
    }
    catch (error) {
        return null;
    }
};

const rememberHlsDescendantPriorities = async (url, response, priority) => {
    if(priority < 1 || !/\.m3u8(?:$|\?)/i.test(url)) {
        return;
    }

    try {
        const manifest = await response.clone().text();
        const lines = manifest.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        let expectVariant = false;
        let firstSegmentRemembered = false;

        for(const line of lines) {
            if(line.startsWith('#EXT-X-STREAM-INF')) {
                expectVariant = true;
                continue;
            }

            if(line.startsWith('#')) {
                continue;
            }

            const childUrl = normalizeCachePriorityUrl(new URL(line, url).href);
            if(!childUrl) {
                expectVariant = false;
                continue;
            }

            if(expectVariant || /\.m3u8(?:$|\?)/i.test(childUrl)) {
                hlsDescendantPriorityUrls.set(childUrl, Math.max(priority, Number(hlsDescendantPriorityUrls.get(childUrl) || 0)));
                expectVariant = false;
                continue;
            }

            if(! firstSegmentRemembered) {
                hlsDescendantPriorityUrls.set(childUrl, Math.max(priority, Number(hlsDescendantPriorityUrls.get(childUrl) || 0)));
                firstSegmentRemembered = true;
            }
        }
    }
    catch (error) {
        // A malformed or opaque playlist simply receives ordinary LRU treatment.
    }
};

const isCacheableBasicResponse = (response) => {
    return response && response.ok && ['basic', 'cors', 'default'].includes(response.type);
};

const cacheFirst = async (request, cacheName) => {
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(request);

    if(cachedResponse) {
        return cachedResponse;
    }

    const response = await fetch(request);

    if(isCacheableBasicResponse(response)) {
        cache.put(request, response.clone()).catch(() => {});
    }

    return response;
};

const isHtmlNavigationResponse = (response) => {
    const contentType = response?.headers?.get('content-type') || '';

    return isCacheableBasicResponse(response) && contentType.includes('text/html');
};

const networkFirstNavigation = async (request) => {
    const cache = await caches.open(shellCacheName);
    const cachedShell = await cache.match(navigationShellRequest);
    const networkPromise = fetch(request)
        .then((response) => {
            if(isHtmlNavigationResponse(response)) {
                cache.put(navigationShellRequest, response.clone()).catch(() => {});
            }

            return response;
        })
        .catch(() => null);

    const fastResponse = await Promise.race([
        networkPromise,
        wait(navigationTimeoutMs).then(() => cachedShell || null),
    ]);

    if(fastResponse) {
        return fastResponse;
    }

    const networkResponse = await networkPromise;

    if(networkResponse) {
        return networkResponse;
    }

    if(cachedShell) {
        return cachedShell;
    }

    return Response.error();
};

const readMediaMeta = async (cache) => {
    try {
        const response = await cache.match(mediaMetaRequest);

        if(! response) {
            return { entries: {} };
        }

        return await response.json();
    }
    catch (error) {
        return { entries: {} };
    }
};

const writeMediaMeta = async (cache, meta) => {
    return await cache.put(mediaMetaRequest, new Response(JSON.stringify(meta), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        },
    }));
};

const pruneMediaCache = async (cache, meta) => {
    const entries = Object.entries(meta.entries || {})
        .sort((left, right) => {
            const priorityDifference = Number(left[1].priority || 0) - Number(right[1].priority || 0);
            return priorityDifference || Number(left[1].last_accessed_at || 0) - Number(right[1].last_accessed_at || 0);
        });
    let totalBytes = entries.reduce((total, entry) => {
        return total + Number(entry[1].size || 0);
    }, 0);
    let totalEntries = entries.length;

    for(const [url, entry] of entries) {
        if(totalBytes <= mediaCacheMaxBytes && totalEntries <= mediaCacheMaxEntries) {
            break;
        }

        await cache.delete(url);
        delete meta.entries[url];
        totalBytes -= Number(entry.size || 0);
        totalEntries--;
    }

    await writeMediaMeta(cache, meta);
};

const rememberMediaMeta = async (cache, request, response, cachedAt = Date.now()) => {
    const contentLength = Number(response?.headers?.get('content-length') || 0);
    const meta = await readMediaMeta(cache);

    meta.entries = meta.entries || {};
    meta.entries[request.url] = {
        size: Number.isFinite(contentLength) ? contentLength : 0,
        cached_at: meta.entries[request.url]?.cached_at || cachedAt,
        last_accessed_at: cachedAt,
        content_type: response?.headers?.get('content-type') || null,
        priority: mediaPriorityForUrl(request.url),
    };

    await writeMediaMeta(cache, meta);
    await pruneMediaCache(cache, meta);
};

const canCacheMediaResponse = (request, response) => {
    if(! isCacheableBasicResponse(response)) {
        return false;
    }

    if(request.headers.has('range') || response.status === 206) {
        return false;
    }

    const contentLength = Number(response.headers.get('content-length') || 0);

    return ! contentLength || contentLength <= mediaCacheMaxSingleBytes;
};

const mediaPrefetchPromises = new Map();

const cacheMediaResource = async (url, priority) => {
    const normalizedUrl = normalizeCachePriorityUrl(url);

    if(! normalizedUrl) {
        return null;
    }

    const pending = mediaPrefetchPromises.get(normalizedUrl);
    if(pending) {
        return pending;
    }

    const prefetchPromise = (async () => {
        const request = new Request(normalizedUrl, {
            mode: 'cors',
            credentials: 'omit',
        });
        const cache = await caches.open(mediaCacheName);
        const cachedResponse = await cache.match(request);

        if(cachedResponse) {
            await rememberHlsDescendantPriorities(normalizedUrl, cachedResponse, priority);
            await rememberMediaMeta(cache, request, cachedResponse.clone());

            return cachedResponse;
        }

        const response = await fetch(request);
        await rememberHlsDescendantPriorities(normalizedUrl, response, priority);

        if(canCacheMediaResponse(request, response)) {
            await cache.put(request, response.clone());
            await rememberMediaMeta(cache, request, response.clone());
        }

        return response;
    })().catch(() => null).finally(() => {
        mediaPrefetchPromises.delete(normalizedUrl);
    });

    mediaPrefetchPromises.set(normalizedUrl, prefetchPromise);

    return prefetchPromise;
};

const prefetchHlsPlayback = async (url, priority, preferredShortEdge = 0) => {
    const masterResponse = await cacheMediaResource(url, priority);

    if(! masterResponse?.ok) {
        return;
    }

    try {
        const masterText = await masterResponse.clone().text();
        const lines = masterText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        let streamAttributes = null;
        const variants = [];

        for(const line of lines) {
            if(line.startsWith('#EXT-X-STREAM-INF')) {
                streamAttributes = line.slice(line.indexOf(':') + 1);
                continue;
            }

            if(line.startsWith('#')) {
                continue;
            }

            if(streamAttributes) {
                const variantUrl = normalizeCachePriorityUrl(new URL(line, url).href);
                const resolution = streamAttributes.match(/(?:^|,)\s*RESOLUTION=(\d+)x(\d+)/i);
                if(variantUrl) {
                    const width = Number(resolution?.[1] || 0);
                    const height = Number(resolution?.[2] || 0);
                    variants.push({ url: variantUrl, shortEdge: width > 0 && height > 0 ? Math.min(width, height) : 0 });
                }
                streamAttributes = null;
            }
        }

        const underTarget = variants.filter((variant) => variant.shortEdge > 0 && preferredShortEdge > 0 && variant.shortEdge <= preferredShortEdge);
        const selectedVariant = underTarget.sort((left, right) => right.shortEdge - left.shortEdge)[0]
            || variants.filter((variant) => variant.shortEdge > 0).sort((left, right) => left.shortEdge - right.shortEdge)[0]
            || variants[0];
        const variantUrl = selectedVariant?.url || null;

        if(! variantUrl) {
            const firstSegment = lines.find((line) => !line.startsWith('#'));
            const segmentUrl = firstSegment ? normalizeCachePriorityUrl(new URL(firstSegment, url).href) : null;

            if(segmentUrl && !/\.m3u8(?:$|\?)/i.test(segmentUrl)) {
                hlsDescendantPriorityUrls.set(segmentUrl, Math.max(priority, Number(hlsDescendantPriorityUrls.get(segmentUrl) || 0)));
                await cacheMediaResource(segmentUrl, priority);
            }

            return;
        }

        hlsDescendantPriorityUrls.set(variantUrl, Math.max(priority, Number(hlsDescendantPriorityUrls.get(variantUrl) || 0)));
        const variantResponse = await cacheMediaResource(variantUrl, priority);

        if(! variantResponse?.ok) {
            return;
        }

        const variantText = await variantResponse.clone().text();
        const firstSegment = variantText.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
        const segmentUrl = firstSegment ? normalizeCachePriorityUrl(new URL(firstSegment, variantUrl).href) : null;

        if(segmentUrl && !/\.m3u8(?:$|\?)/i.test(segmentUrl)) {
            hlsDescendantPriorityUrls.set(segmentUrl, Math.max(priority, Number(hlsDescendantPriorityUrls.get(segmentUrl) || 0)));
            await cacheMediaResource(segmentUrl, priority);
        }
    }
    catch (error) {
        // Playback will still fetch the playlist and segments on demand.
    }
};

const prefetchHlsWindow = async (current = [], next = [], preferredShortEdge = 720) => {
    const orderedUrls = [
        ...current.filter((url) => /\.m3u8(?:$|\?)/i.test(url)).slice(0, 1).map((url) => [url, 3]),
        ...next.filter((url) => /\.m3u8(?:$|\?)/i.test(url)).slice(0, 2).map((url) => [url, 2]),
    ];

    for(const [url, priority] of orderedUrls) {
        await prefetchHlsPlayback(url, priority, Number(preferredShortEdge));
    }
};

const mediaStaleWhileRevalidate = async (request) => {
    // A cached full response must never replace a byte-range response expected by the video element.
    if(request.headers.has('range')) {
        return fetch(request);
    }

    const cache = await caches.open(mediaCacheName);
    const cachedResponse = await cache.match(request);
    if(cachedResponse) {
        await rememberHlsDescendantPriorities(request.url, cachedResponse, mediaPriorityForUrl(request.url));
        rememberMediaMeta(cache, request, cachedResponse.clone()).catch(() => {});

        const cacheControl = cachedResponse.headers.get('cache-control') || '';
        if(/\bimmutable\b/i.test(cacheControl) && /(?:^|,)\s*max-age=\d+/i.test(cacheControl)) {
            return cachedResponse;
        }
    }

    const refreshPromise = fetch(request)
        .then(async (response) => {
            await rememberHlsDescendantPriorities(request.url, response, mediaPriorityForUrl(request.url));

            if(canCacheMediaResponse(request, response)) {
                cache.put(request, response.clone())
                    .then(() => rememberMediaMeta(cache, request, response.clone()))
                    .catch(() => {});
            }

            return response;
        })
        .catch(() => null);

    if(cachedResponse) {
        return cachedResponse;
    }

    const response = await refreshPromise;

    return response || Response.error();
};

self.addEventListener('install', (event) => {
    event.waitUntil(precacheAppShell().finally(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(deleteOldCaches().then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
    const messageType = event?.data?.type;

    if(messageType === 'ZULORS_SKIP_WAITING') {
        self.skipWaiting();
    }

    if(messageType === 'ZULORS_PURGE_NAVIGATION_SHELL') {
        caches.open(shellCacheName)
            .then((cache) => cache.delete(navigationShellRequest))
            .catch(() => {});
    }

    if(messageType === 'ZULORS_REELS_CACHE_WINDOW') {
        const nextPriorities = new Map();
        (Array.isArray(event.data?.current) ? event.data.current : []).forEach((value) => {
            const url = normalizeCachePriorityUrl(value);
            if(url) nextPriorities.set(url, 3);
        });
        (Array.isArray(event.data?.next) ? event.data.next : []).forEach((value) => {
            const url = normalizeCachePriorityUrl(value);
            if(url && !nextPriorities.has(url)) nextPriorities.set(url, 2);
        });
        reelCachePriorityUrls = nextPriorities;
        hlsDescendantPriorityUrls = new Map();

        const updatePriorities = caches.open(mediaCacheName).then(async (cache) => {
            const meta = await readMediaMeta(cache);
            Object.entries(meta.entries || {}).forEach(([url, entry]) => {
                entry.priority = mediaPriorityForUrl(url);
            });
            await writeMediaMeta(cache, meta);
            await pruneMediaCache(cache, meta);
        });
        const prefetchPlayback = event.data?.prefetch === false
            ? Promise.resolve()
            : prefetchHlsWindow(event.data?.current, event.data?.next, event.data?.preferredShortEdge);

        event.waitUntil?.(Promise.all([updatePriorities, prefetchPlayback]));
    }
});

self.addEventListener('fetch', (event) => {
    const request = event.request;

    if(request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);

    if(isApiRequest(url)) {
        return;
    }

    if(request.mode === 'navigate') {
        event.respondWith(networkFirstNavigation(request));

        return;
    }

    if(isBuildAssetRequest(url) || isPwaStaticRequest(url)) {
        event.respondWith(cacheFirst(request, shellCacheName));

        return;
    }

    if(isMediaRequest(request, url)) {
        event.respondWith(mediaStaleWhileRevalidate(request));
    }
});
