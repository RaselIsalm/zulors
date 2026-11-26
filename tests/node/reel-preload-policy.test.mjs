import test from 'node:test';
import assert from 'node:assert/strict';

import { applyReelPreloadPolicy, applyReelStartupQualityPolicy, getPreferredReelLevelIndex, getReelPreloadPolicy, getRequiredStartupBufferSeconds, getSustainableReelLevelIndex } from '../../resources/js/spa/kernel/services/media/reel-preload-policy.js';

test('startup buffer target is capped to the remaining duration of short videos', () => {
	assert.equal(getRequiredStartupBufferSeconds(3, 0), 0.25);
	assert.equal(getRequiredStartupBufferSeconds(60, 2), 0.25);
	assert.equal(getRequiredStartupBufferSeconds(60, 58), 0.25);
	assert.equal(getRequiredStartupBufferSeconds(Number.POSITIVE_INFINITY, 0), 0.25);
});

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
        abrEwmaDefaultEstimate: 5_000_000,
        preferredShortEdge: 720,
		startupBufferSeconds: 0.25,
		startupHdWaitMs: 1_000,
        nextBufferSeconds: 4,
        stallIndicatorDelayMs: 2_000,
        autoLevelCapping: -1,
        maxBufferLength: 5,
        maxMaxBufferLength: 5,
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

test('slow connections warm one upcoming reel and normal connections warm two', () => {
    assert.equal(getReelPreloadPolicy({ distanceFromActive: 1, networkProfile: { profile: 'slow' } }).shouldWarm, true);
    assert.equal(getReelPreloadPolicy({ distanceFromActive: 2, networkProfile: { profile: 'slow' } }).shouldWarm, false);
    assert.equal(getReelPreloadPolicy({ distanceFromActive: 2, networkProfile: { profile: 'normal' } }).shouldWarm, true);
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
    assert.equal(policy.abrEwmaDefaultEstimate, 5_000_000);
    assert.equal(policy.preferredShortEdge, 720);
});

test('startup targets HD while the coarse network estimate remains available to ABR', () => {
    const slow = getReelPreloadPolicy({ active: true, networkProfile: { profile: 'slow' } });
    const fast = getReelPreloadPolicy({ active: true, networkProfile: { profile: 'fast' } });
    const measured = getReelPreloadPolicy({ active: true, networkProfile: { profile: 'normal', downlinkMbps: 5 } });
    const coarseLowDownlink = getReelPreloadPolicy({ active: true, networkProfile: { profile: 'very_slow', downlinkMbps: 1.2 } });

    assert.equal(slow.startLevel, -1);
	assert.equal(slow.abrEwmaDefaultEstimate, 1_800_000);
	assert.equal(slow.preferredShortEdge, 720);
    assert.equal(fast.abrEwmaDefaultEstimate, 8_000_000);
	assert.equal(fast.preferredShortEdge, 720);
	assert.equal(measured.abrEwmaDefaultEstimate, 4_500_000);
    assert.equal(measured.preferredShortEdge, 720);
	assert.equal(coarseLowDownlink.abrEwmaDefaultEstimate, 1_080_000);
	assert.equal(coarseLowDownlink.preferredShortEdge, 720);
	assert.equal(getReelPreloadPolicy({ active: true, networkProfile: { profile: 'very_slow' } }).preferredShortEdge, 720);
});

test('startup fallback selects the highest rendition sustainable by measured throughput', () => {
	const levels = [
		{ width: 240, height: 426, bitrate: 500_000 },
		{ width: 360, height: 640, bitrate: 950_000 },
		{ width: 480, height: 854, bitrate: 1_700_000 },
		{ width: 720, height: 1280, bitrate: 3_400_000 },
	];

	assert.equal(getSustainableReelLevelIndex(levels, 1_500_000), 1);
	assert.equal(getSustainableReelLevelIndex(levels, 2_500_000), 2);
	assert.equal(getSustainableReelLevelIndex(levels, 5_000_000), 3);
	assert.equal(getSustainableReelLevelIndex(levels, 0), 0);
});

test('the initial HLS rendition selects the highest rung at or below the network target', () => {
    const levels = [
        { height: 480, bitrate: 2_000_000 },
        { height: 240, bitrate: 700_000 },
        { height: 720, bitrate: 4_000_000 },
        { height: 360, bitrate: 1_100_000 },
        { height: 1080, bitrate: 7_200_000 },
    ];

    assert.equal(getPreferredReelLevelIndex(levels, 720), 2);
    assert.equal(getPreferredReelLevelIndex(levels, 480), 0);
    assert.equal(getPreferredReelLevelIndex(levels, 180), 1);
    assert.equal(getPreferredReelLevelIndex([], 720), -1);
});

test('portrait HLS levels select the network target by short edge instead of frame height', () => {
    const levels = [
        { width: 240, height: 426, bitrate: 800_000 },
        { width: 360, height: 640, bitrate: 1_400_000 },
        { width: 480, height: 854, bitrate: 2_400_000 },
        { width: 720, height: 1280, bitrate: 4_400_000 },
        { width: 1080, height: 1920, bitrate: 7_800_000 },
    ];

    assert.equal(getPreferredReelLevelIndex(levels, 720), 3);
    assert.equal(getPreferredReelLevelIndex(levels, 1080), 4);
});

test('automatic reel quality can step down after a conservative startup estimate', () => {
    const levels = [
        { width: 240, height: 426, bitrate: 700_000, maxBitrate: 800_000 },
        { width: 360, height: 640, bitrate: 1_100_000, maxBitrate: 1_300_000 },
        { width: 480, height: 854, bitrate: 1_800_000, maxBitrate: 2_100_000 },
        { width: 720, height: 1280, bitrate: 3_400_000, maxBitrate: 3_850_000 },
        { width: 1080, height: 1920, bitrate: 6_200_000, maxBitrate: 6_900_000 },
    ];
    const hls = { levels, startLevel: -1, config: { minAutoBitrate: 0 } };

    assert.deepEqual(applyReelStartupQualityPolicy(hls, 1080), {
        preferredLevel: 4,
		requestedLevel: 4,
		minAutoBitrate: 0,
    });
    assert.equal(hls.startLevel, 4);
	assert.equal(hls.config.minAutoBitrate, 0);
});

test('automatic quality leaves the bitrate floor off when a source has no HD rendition', () => {
    const levels = [
        { width: 240, height: 426, bitrate: 700_000 },
        { width: 360, height: 640, bitrate: 1_100_000 },
        { width: 480, height: 854, bitrate: 1_800_000 },
    ];
    const hls = { levels, startLevel: -1, config: { minAutoBitrate: 1_100_000 } };

    assert.deepEqual(applyReelStartupQualityPolicy(hls, 720), {
        preferredLevel: 2,
		requestedLevel: 2,
        minAutoBitrate: 0,
    });
    assert.equal(hls.startLevel, 2);
    assert.equal(hls.config.minAutoBitrate, 0);
});

test('slow startup selects a sustainable rung instead of forcing an HD timeout', () => {
	const levels = [
		{ width: 240, height: 426, bitrate: 700_000 },
		{ width: 360, height: 640, bitrate: 1_100_000 },
		{ width: 480, height: 854, bitrate: 2_000_000 },
		{ width: 720, height: 1280, bitrate: 3_600_000 },
	];
	const hls = { levels, startLevel: -1, config: { minAutoBitrate: 1_100_000 } };

	assert.deepEqual(applyReelStartupQualityPolicy(hls, 720, 1_800_000), {
		preferredLevel: 1,
		requestedLevel: 3,
		minAutoBitrate: 0,
	});
	assert.equal(hls.startLevel, 1);
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
    assert.equal(hls.abrEwmaDefaultEstimate, 5_000_000);
    assert.equal(hls.config.maxBufferLength, 16);
    assert.equal(hls.config.maxMaxBufferLength, 24);
});
