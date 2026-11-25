import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '@vue/compiler-sfc';

const platforms = {
    mobile: 'mobile',
    desktop: 'desktop',
};

for(const platform of Object.values(platforms)) {
    test(`${platform} feed keeps the poster mounted and only creates a player near the viewport`, async () => {
        const publicationPath = `../../resources/js/spa/apps/${platform}/components/timeline/feed/parts/media/PublicationVideo.vue`;
        const playerPath = `../../resources/js/spa/apps/${platform}/components/players/video/VideoPlayer.vue`;
        const publication = parse((await readFile(new URL(publicationPath, import.meta.url))).toString()).descriptor;
        const player = parse((await readFile(new URL(playerPath, import.meta.url))).toString()).descriptor;

        assert.match(publication.template.content, /ref="mediaViewportRef"/);
        assert.match(publication.template.content, /v-bind:loading="isPriority \? 'eager' : 'lazy'"/);
        assert.match(publication.template.content, /v-bind:fetchpriority="isPriority \? 'high' : 'auto'"/);
        assert.match(publication.template.content, /v-bind:thumbnailUrl="posterUrl"/);
        assert.match(publication.script.content, /thumbnail_url \|\| (?:mediaItem\.value\.poster_url \|\| )?mediaItem\.value\.lqip_base64/);
        assert.match(publication.template.content, /v-if="isNearViewport"/);
        assert.match(publication.script.content, /rootMargin: '1200px 0px'/);
        assert.match(player.template.content, /preload="metadata"/);
		assert.match(player.template.content, /state\.showBufferIndicator/);
		assert.doesNotMatch(player.template.content, /state\.playRequested && !state\.isPlaying/);
		assert.match(player.template.content, /v-on:waiting="handleVideoWaiting"/);
        assert.doesNotMatch(player.template.content, /<video[^>]+(?:src|v-bind:src)=/);
        assert.match(player.script.content, /createAdaptiveVideoPlaybackController/);
		assert.match(player.script.content, /REEL_STARTUP_BUFFER_SECONDS/);
		assert.match(player.script.content, /REEL_STARTUP_HD_WAIT_MS/);
		assert.match(player.script.content, /REEL_STALL_INDICATOR_DELAY_MS/);
		assert.match(player.script.content, /playbackController\.setCallbacks\(\{ onBuffer: handlePlaybackProgress \}\)/);
        assert.match(player.script.content, /const togglePlayback = \(\) => \{\s*if\(state\.isPlaying \|\| state\.playRequested\)/);
        assert.doesNotMatch(player.script.content, /handleVideoSurfaceClick:[\s\S]{0,450}if\(state\.isLoaded\)/);
        assert.match(player.script.content, /playbackController\.setSource\(playbackSource\.value, directFallbackSource\.value\)/);
        const mounted = player.script.content.match(/onMounted\(\(\) => \{([\s\S]*?)\n\s*\}\);/)?.[1] || '';
        assert.doesNotMatch(mounted, /playbackController\.attach\(/);
        if(platform === platforms.mobile) {
            assert.match(player.script.content, /isReady: Boolean\(playbackSource\.value\.url\) && ! state\.isScrubbing/);
            assert.match(player.script.content, /if\(! playbackAttached\)[\s\S]*playbackController\?\.attach\(playbackSource\.value, directFallbackSource\.value\)/);
            assert.match(player.script.content, /playbackController\.setSource\(playbackSource\.value, directFallbackSource\.value\);[\s\S]*syncPlaybackCandidate\(\);/);
        }
        else {
            assert.match(player.script.content, /isReady: Boolean\(playbackSource\.value\.url\) && ! state\.isScrubbing/);
            assert.match(player.script.content, /if\(! playbackAttached\)[\s\S]*playbackController\?\.attach\(playbackSource\.value, directFallbackSource\.value\)/);
        }
    });
}

for(const platform of Object.values(platforms)) {
    test(`${platform} marks the first feed video as priority for an immediate poster`, async () => {
        const timelinePath = `../../resources/js/spa/apps/${platform}/components/timeline/feed/TimelinePublication.vue`;
        const timeline = parse((await readFile(new URL(timelinePath, import.meta.url))).toString()).descriptor;

        assert.match(timeline.template.content, /v-bind:isPriority="position === 1"/);
    });
}

test('timeline prefetch keeps image lookahead and bounds the HLS cache window', async () => {
    const source = (await readFile(new URL('../../resources/js/spa/kernel/services/media-prefetch/index.js', import.meta.url))).toString();
	const worker = (await readFile(new URL('../../public/pwa/service-worker.js', import.meta.url))).toString();

    assert.doesNotMatch(source, /createElement\(['"]video['"]\)/);
    assert.match(source, /prefetchImage\(mediaItem\.thumbnail_url\)/);
    assert.match(source, /collectHlsPlaybackUrls\(postsBatch, isSlowNetworkProfile\(networkProfile\) \? 2 : 3\)/);
    assert.match(source, /type: 'ZULORS_REELS_CACHE_WINDOW'/);
	assert.match(source, /currentBufferSeconds: REEL_STARTUP_BUFFER_SECONDS/);
	assert.doesNotMatch(source, /requestIdleCallback/);
    assert.match(source, /prefetch: !networkProfile\.offline && !networkProfile\.saveData/);
	assert.match(worker, /bufferedSeconds >= Math\.max\(1, Number\(targetBufferSeconds \|\| 2\)\)/);
	assert.match(worker, /currentBufferSeconds = 5/);
});

for(const platform of Object.values(platforms)) {
    test(`${platform} primes Reels with the tapped feed post before navigating`, async () => {
        const timelinePath = `../../resources/js/spa/apps/${platform}/components/timeline/feed/TimelinePublication.vue`;
        const storePath = `../../resources/js/spa/apps/${platform}/store/explore/reels.store.js`;
        const timeline = parse((await readFile(new URL(timelinePath, import.meta.url))).toString()).descriptor;
        const store = (await readFile(new URL(storePath, import.meta.url))).toString();

        assert.match(timeline.script.content, /reelsStore\.primeWithPost\(postData\.value, playbackState\)/);
        assert.match(store, /entryPostHashId === nextSeedHashId/);
        assert.match(store, /playbackHandoff/);
    });
}

for(const platform of Object.values(platforms)) {
	 test(`${platform} starts an active Reel when WebView exposes its first decoded frame`, async () => {
		const playerPath = `../../resources/js/spa/apps/${platform}/components/reels/ReelVideoPlayer.vue`;
		const player = (await readFile(new URL(playerPath, import.meta.url))).toString();

		assert.match(player, /const hasDecodableFrame = readyState >= 2/);
		assert.match(player, /const isReady = transferredMediaReady \|\| hasBufferedAhead \|\| hasDecodableFrame/);
	});
}
