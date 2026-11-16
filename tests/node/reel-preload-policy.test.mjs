import test from 'node:test';
import assert from 'node:assert/strict';

import { applyReelPreloadPolicy, getReelPreloadPolicy } from '../../resources/js/spa/kernel/services/media/reel-preload-policy.js';

test('the next reel preloads one low-resolution segment then keeps its buffer bounded', () => {
    assert.deepEqual(getReelPreloadPolicy({
        isNext: true,
        networkProfile: {
            profile: 'normal',
            reelsMaxBufferLength: 16,
            reelsMaxMaxBufferLength: 24,
        },
    }), {
        prewarmingNext: true,
        shouldWarm: true,
        startLevel: 0,
        autoLevelCapping: 0,
        maxBufferLength: 4,
        maxMaxBufferLength: 4,
    });
});

test('the next reel is not prefetched offline or with data saver enabled', () => {
    for (const networkProfile of [
        { profile: 'offline', offline: true },
        { profile: 'very_slow', saveData: true },
    ]) {
        const policy = getReelPreloadPolicy({ isNext: true, networkProfile });
        assert.equal(policy.prewarmingNext, false);
        assert.equal(policy.shouldWarm, false);
        assert.equal(policy.autoLevelCapping, -1);
    }
});

test('the active reel is not capped to the warmup rendition', () => {
    const policy = getReelPreloadPolicy({
        active: true,
        isNext: true,
        networkProfile: { profile: 'normal', reelsMaxBufferLength: 16, reelsMaxMaxBufferLength: 24 },
    });

    assert.equal(policy.shouldWarm, true);
    assert.equal(policy.prewarmingNext, false);
    assert.equal(policy.autoLevelCapping, -1);
    assert.equal(policy.maxBufferLength, 16);
});

test('activating the warmed reel removes its rendition cap and expands the HLS buffer', () => {
    const hls = {
        autoLevelCapping: 0,
        config: { maxBufferLength: 4, maxMaxBufferLength: 4 },
    };
    const activePolicy = getReelPreloadPolicy({
        active: true,
        networkProfile: { profile: 'normal', reelsMaxBufferLength: 16, reelsMaxMaxBufferLength: 24 },
    });

    applyReelPreloadPolicy(hls, activePolicy);

    assert.equal(hls.autoLevelCapping, -1);
    assert.equal(hls.config.maxBufferLength, 16);
    assert.equal(hls.config.maxMaxBufferLength, 24);
});
