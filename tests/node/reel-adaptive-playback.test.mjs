import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    buildAdaptiveVideoSource,
    getDirectPlaybackFallback,
} from '../../resources/js/spa/kernel/services/media/adaptive-video/index.js';

test('an allowlisted HLS master is preferred while the canonical MP4 remains the fallback', () => {
    const media = {
        source_url: 'https://cdn.example.test/original.mp4',
        extension: 'mp4',
        metadata: {
            playback: {
                hls: 'https://cdn.example.test/master.m3u8',
                hls_state: 'ready',
            },
        },
    };

    assert.deepEqual(buildAdaptiveVideoSource(media), {
        url: 'https://cdn.example.test/master.m3u8',
        type: 'application/vnd.apple.mpegurl',
        transport: 'hls',
    });
    assert.deepEqual(getDirectPlaybackFallback(media), {
        url: 'https://cdn.example.test/original.mp4',
        type: 'video/mp4',
        transport: 'direct',
    });
});

test('missing or failed HLS metadata resolves directly to the original MP4', () => {
    const media = {
        source_url: 'https://cdn.example.test/original.mp4',
        extension: 'mp4',
        metadata: {
            playback: {
                hls: null,
                hls_state: 'failed',
            },
        },
    };

    assert.equal(buildAdaptiveVideoSource(media).url, media.source_url);
    assert.equal(buildAdaptiveVideoSource(media).transport, 'direct');
    assert.equal(getDirectPlaybackFallback(media).url, media.source_url);
});

test('active Reels starts HLS loading when media attaches', async () => {
    const source = await readFile(new URL(
        '../../resources/js/spa/apps/mobile/components/reels/ReelVideoPlayer.vue',
        import.meta.url,
    ), 'utf8');
    const mediaAttachedBlock = source.match(
        /instance\.on\(Hls\.Events\.MEDIA_ATTACHED, \(\) => \{[\s\S]*?instance\.attachMedia\(videoElement\);/
    )?.[0] || '';

    assert.match(mediaAttachedBlock, /instance\.loadSource\(source\.url\)/);
    assert.match(mediaAttachedBlock, /shouldWarmPlayback\.value/);
    assert.match(mediaAttachedBlock, /instance\.startLoad\(hlsStartPosition\(\)\)/);
});
