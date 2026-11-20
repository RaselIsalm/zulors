import test from 'node:test';
import assert from 'node:assert/strict';

import { applyReelPreloadPolicy, getReelPreloadPolicy } from '../../resources/js/spa/kernel/services/media/reel-preload-policy.js';

test('the next reel preloads one network-appropriate segment then keeps its buffer bounded', () => {
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
        startLevel: -1,
        abrEwmaDefaultEstimate: 3_200_000,
        preferredHeight: 720,
        autoLevelCapping: -1,
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
    assert.equal(policy.startLevel, -1);
    assert.equal(policy.abrEwmaDefaultEstimate, 3_200_000);
    assert.equal(policy.preferredHeight, 720);
});

test('startup quality follows the available network estimate without pinning slow connections to a tiny rung', () => {
    const slow = getReelPreloadPolicy({ active: true, networkProfile: { profile: 'slow' } });
    const fast = getReelPreloadPolicy({ active: true, networkProfile: { profile: 'fast' } });
    const measured = getReelPreloadPolicy({ active: true, networkProfile: { profile: 'normal', downlinkMbps: 5 } });

    assert.equal(slow.startLevel, -1);
    assert.equal(slow.abrEwmaDefaultEstimate, 1_800_000);
    assert.equal(slow.preferredHeight, 480);
    assert.equal(fast.abrEwmaDefaultEstimate, 5_000_000);
    assert.equal(fast.preferredHeight, 720);
    assert.equal(measured.abrEwmaDefaultEstimate, 3_750_000);
    assert.equal(measured.preferredHeight, 720);
});

test('activating the warmed reel updates its adaptive estimate and expands the HLS buffer', () => {
    const hls = {
        autoLevelCapping: 0,
        abrEwmaDefaultEstimate: 500_000,
        config: { maxBufferLength: 4, maxMaxBufferLength: 4 },
    };
    const activePolicy = getReelPreloadPolicy({
        active: true,
        networkProfile: { profile: 'normal', reelsMaxBufferLength: 16, reelsMaxMaxBufferLength: 24 },
    });

    applyReelPreloadPolicy(hls, activePolicy);

    assert.equal(hls.autoLevelCapping, -1);
    assert.equal(hls.abrEwmaDefaultEstimate, 3_200_000);
    assert.equal(hls.config.maxBufferLength, 16);
    assert.equal(hls.config.maxMaxBufferLength, 24);
});
