import { buildAdaptiveVideoSource } from '@/kernel/services/media/adaptive-video/index.js';
import { getNetworkProfileSnapshot, isSlowNetworkProfile } from '@/kernel/services/network/index.js';
import {
	getReelPlaybackStartupPolicy,
	REEL_NEXT_BUFFER_SECONDS,
	REEL_STARTUP_BUFFER_SECONDS,
} from '@/kernel/services/media/reel-preload-policy.js';

const prefetchedUrls = new Map();
let queuedPosts = new Map();
let queuedLimit = 0;
let prefetchHandle = null;

function canPrefetch() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function prefetchImage(url) {
    if(! url || prefetchedUrls.has(url) || ! canPrefetch()) {
        return;
    }

    if(prefetchedUrls.size >= 400) {
        prefetchedUrls.delete(prefetchedUrls.keys().next().value);
    }

    prefetchedUrls.set(url, 1);

    const image = new Image();
    image.decoding = 'async';
    image.loading = 'eager';
    image.src = url;
}

function prefetchPostMedia(postData, state) {
	const mediaItems = postData?.relations?.media || [];

	mediaItems.forEach((mediaItem) => {
		if(state.count >= state.limit) {
			return;
		}

		if(mediaItem.type === 'video') {
			prefetchImage(mediaItem.thumbnail_url);
		}
		else {
			prefetchImage(mediaItem.source_url);
		}

		state.count++;
	});

	if(postData?.relations?.quoted_post) {
		prefetchPostMedia(postData.relations.quoted_post, state);
	}
}

function collectHlsPlaybackUrls(posts = [], limit = 2) {
    const urls = [];

    const visitPost = (postData) => {
        if(! postData || urls.length >= limit) {
            return;
        }

        const mediaItems = postData?.relations?.media || [];

        for(const mediaItem of mediaItems) {
            if(mediaItem?.type !== 'video') {
                continue;
            }

            const source = buildAdaptiveVideoSource(mediaItem);

            if(source.transport === 'hls' && source.url && !urls.includes(source.url)) {
                urls.push(source.url);
            }

            if(urls.length >= limit) {
                return;
            }
        }

        visitPost(postData?.relations?.quoted_post);
    };

    posts.forEach(visitPost);

    return urls;
}

function publishPlaybackCacheWindow(current = [], next = [], networkProfile = {}) {
    const serviceWorker = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;

    if(! serviceWorker) {
        return;
    }

    const message = {
        type: 'ZULORS_REELS_CACHE_WINDOW',
        current,
        next,
        preferredShortEdge: getReelPlaybackStartupPolicy(networkProfile).preferredShortEdge,
        currentBufferSeconds: REEL_STARTUP_BUFFER_SECONDS,
        nextBufferSeconds: REEL_NEXT_BUFFER_SECONDS,
        prefetch: !networkProfile.offline && !networkProfile.saveData
    };
    const worker = serviceWorker.controller;

    if(worker) {
        worker.postMessage(message);
        return;
    }

    serviceWorker.ready?.then((registration) => {
        registration.active?.postMessage(message);
    }).catch(() => {});
}

function prefetchTimelineMedia(posts = [], limit = 8, options = {}) {
    if(! canPrefetch() || ! Array.isArray(posts)) {
        return;
    }

	const initialNetworkProfile = getNetworkProfileSnapshot();
	if(initialNetworkProfile.offline) {
		return;
	}

	const effectiveLimit = isSlowNetworkProfile(initialNetworkProfile)
		? Math.max(1, Math.ceil(limit / 2))
		: limit;
	const queueLimit = isSlowNetworkProfile(initialNetworkProfile)
		? Math.max(effectiveLimit * 2, effectiveLimit)
		: Math.max(effectiveLimit * 3, effectiveLimit);

    posts.slice(0, queueLimit).forEach((postData, index) => {
        const key = postData?.hash_id || postData?.id || postData || index;

        if(queuedPosts.size < 60 && !queuedPosts.has(key)) {
            queuedPosts.set(key, postData);
        }
    });
	queuedLimit = Math.max(queuedLimit, effectiveLimit);

	const runPrefetch = () => {
		prefetchHandle = null;
		const networkProfile = getNetworkProfileSnapshot();

		if(document.visibilityState === 'hidden' || networkProfile.offline || networkProfile.saveData) {
			queuedPosts = new Map();
			queuedLimit = 0;

			return;
		}

		const postsBatch = Array.from(queuedPosts.values());
		queuedPosts = new Map();
		const limitBatch = queuedLimit || effectiveLimit;
		queuedLimit = 0;

        if(! postsBatch.length) {
            return;
        }

		const state = {
			count: 0,
			limit: limitBatch
		};

		postsBatch.some((postData) => {
			prefetchPostMedia(postData, state);

			return state.count >= state.limit;
		});

		const playbackUrls = collectHlsPlaybackUrls(postsBatch, isSlowNetworkProfile(networkProfile) ? 2 : 3);
		publishPlaybackCacheWindow(playbackUrls.slice(0, 1), playbackUrls.slice(1, 3), networkProfile);
	};

	if(prefetchHandle) {
		return;
	}

    // The feed already batches and bounds prefetch work. Waiting for idle can
    // put the next video behind the user's scroll by multiple seconds.
	prefetchHandle = window.setTimeout(runPrefetch, options.immediate ? 0 : 100);
}

function prefetchReelsPlaybackWindow(posts = [], activeIndex = 0) {
    if(! Array.isArray(posts) || ! posts.length) {
        return;
    }

    const networkProfile = getNetworkProfileSnapshot();

    const safeActiveIndex = Math.max(0, Math.min(posts.length - 1, Number(activeIndex || 0)));
    const activePost = posts[safeActiveIndex];
    const profile = String(networkProfile.profile || 'normal');
    const upcomingCount = ['slow', 'very_slow'].includes(profile) ? 1 : 2;
    const upcomingPosts = posts.slice(safeActiveIndex + 1, safeActiveIndex + 1 + upcomingCount);

    const collectPostCacheUrls = (postData) => {
        const mediaItems = postData?.relations?.media || [];

        return mediaItems.filter((mediaItem) => mediaItem?.type === 'video').flatMap((mediaItem) => {
            if(mediaItem.thumbnail_url && ! networkProfile.offline) {
                prefetchImage(mediaItem.thumbnail_url);
            }

            const source = buildAdaptiveVideoSource(mediaItem);

            return [mediaItem.thumbnail_url, source.transport === 'hls' ? source.url : ''].filter(Boolean);
        });
    };

    const currentUrls = collectPostCacheUrls(activePost);
    const nextUrls = upcomingPosts.flatMap(collectPostCacheUrls);

    publishPlaybackCacheWindow(currentUrls, nextUrls, networkProfile);
}

function warmHomeFeedMedia(posts = [], options = {}) {
    const networkProfile = getNetworkProfileSnapshot();

    if(networkProfile.offline) {
        return;
    }

    const limit = isSlowNetworkProfile(networkProfile)
        ? Number(options.slowLimit || 4)
        : Number(options.limit || 8);

    prefetchTimelineMedia(posts, limit, {
        immediate: true,
        ...options
    });
}

export { prefetchTimelineMedia, prefetchReelsPlaybackWindow, warmHomeFeedMedia, collectHlsPlaybackUrls };
