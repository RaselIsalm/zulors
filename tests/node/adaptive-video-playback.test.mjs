import test from 'node:test';
import assert from 'node:assert/strict';

import { createAdaptiveVideoPlaybackController, hlsOptionsFor } from '../../resources/js/spa/kernel/services/media/adaptive-video/playback.js';

class FakeHls {
    static Events = { ERROR: 'error', LEVEL_SWITCHED: 'level-switched', MEDIA_ATTACHED: 'media-attached', MANIFEST_PARSED: 'manifest-parsed' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static instances = [];
    static isSupported() { return true; }

    constructor(options) {
        this.options = options;
        this.handlers = new Map();
        this.calls = [];
        this.levels = [
            { height: 240, bitrate: 700_000 },
            { height: 360, bitrate: 1_100_000 },
            { height: 480, bitrate: 2_000_000 },
            { height: 720, bitrate: 4_000_000 },
            { height: 1080, bitrate: 7_200_000 },
        ];
        FakeHls.instances.push(this);
    }

    get startLevel() { return this._startLevel; }
    set startLevel(level) {
        this._startLevel = level;
        this.calls.push(['startLevel', level]);
    }

    on(name, handler) { this.handlers.set(name, handler); }
    trigger(name, data) { this.handlers.get(name)?.(name, data); }
    attachMedia(video) { this.video = video; this.trigger(FakeHls.Events.MEDIA_ATTACHED); }
    loadSource(url) { this.calls.push(['loadSource', url]); }
    startLoad(position) { this.calls.push(['startLoad', position]); }
    stopLoad() { this.calls.push(['stopLoad']); }
    recoverMediaError() { this.calls.push(['recoverMediaError']); }
    destroy() { this.calls.push(['destroy']); }
}

function createVideoElement() {
    const listeners = new Map();
    return {
        currentTime: 0,
        preload: '',
        src: '',
        canPlayType: () => '',
        pause() {},
        load() {},
        removeAttribute(name) { if(name === 'src') this.src = ''; },
        addEventListener(name, handler, options = {}) {
            const items = listeners.get(name) || [];
            items.push({ handler, once: Boolean(options.once) });
            listeners.set(name, items);
        },
        removeEventListener(name, handler) {
            listeners.set(name, (listeners.get(name) || []).filter((item) => item.handler !== handler));
        },
        dispatch(name) {
            const items = listeners.get(name) || [];
            for(const item of [...items]) {
                item.handler();
                if(item.once) this.removeEventListener(name, item.handler);
            }
        },
        getAttribute() { return null; },
        setAttribute() {},
    };
}

const hlsSource = { url: 'https://media.example.test/master.m3u8', type: 'application/vnd.apple.mpegurl', transport: 'hls' };
const mp4Source = { url: 'https://media.example.test/source.mp4', type: 'video/mp4', transport: 'direct' };

test('adaptive playback uses a network-aware initial estimate while retaining ABR on slow networks', () => {
    FakeHls.instances = [];
    const video = createVideoElement();
    const controller = createAdaptiveVideoPlaybackController(video, {
        HlsClass: FakeHls,
        getNetworkProfile: () => ({ profile: 'slow', reelsBackBufferLength: 6, reelsMaxBufferLength: 14, reelsMaxMaxBufferLength: 20 }),
    });

    controller.attach(hlsSource, mp4Source);

    assert.equal(FakeHls.instances[0].options.autoStartLoad, false);
    assert.equal(FakeHls.instances[0].options.startLevel, -1);
    assert.equal(FakeHls.instances[0].options.testBandwidth, false);
    assert.equal(FakeHls.instances[0].options.abrEwmaDefaultEstimate, 1_800_000);
    assert.equal(FakeHls.instances[0].options.maxBufferLength, 14);
    assert.equal(FakeHls.instances[0].calls.some(([name]) => name === 'startLoad'), false);
    FakeHls.instances[0].trigger(FakeHls.Events.MANIFEST_PARSED);
    assert.equal(FakeHls.instances[0].startLevel, 1);
    assert.ok(FakeHls.instances[0].calls.findIndex(([name]) => name === 'startLevel') < FakeHls.instances[0].calls.findIndex(([name]) => name === 'startLoad'));
    assert.ok(FakeHls.instances[0].calls.some(([name]) => name === 'startLoad'));
    controller.destroy();
});

test('normal feed playback starts from an HD-capable bandwidth estimate', () => {
    const options = hlsOptionsFor({ profile: 'normal' });

    assert.equal(options.startLevel, -1);
    assert.equal(options.testBandwidth, false);
    assert.equal(options.abrEwmaDefaultEstimate, 5_000_000);
});

test('fatal HLS network errors retry once then fall back to the canonical MP4', () => {
    FakeHls.instances = [];
    const video = createVideoElement();
    let fallbackCount = 0;
    const controller = createAdaptiveVideoPlaybackController(video, {
        HlsClass: FakeHls,
        getNetworkProfile: () => ({ profile: 'normal' }),
        onFallback: () => fallbackCount++,
    });

    controller.attach(hlsSource, mp4Source);
    const hls = FakeHls.instances[0];
    hls.trigger(FakeHls.Events.MANIFEST_PARSED);
    hls.trigger(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR });
    assert.equal(hls.calls.filter(([name]) => name === 'startLoad').length, 2);

    hls.trigger(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR });

    assert.equal(video.src, mp4Source.url);
    assert.equal(fallbackCount, 1);
    controller.destroy();
});

test('suspended off-screen playback releases HLS and restores its position on return', () => {
    FakeHls.instances = [];
    const video = createVideoElement();
    const controller = createAdaptiveVideoPlaybackController(video, {
        HlsClass: FakeHls,
        getNetworkProfile: () => ({ profile: 'normal' }),
    });

    controller.attach(hlsSource, mp4Source);
    const firstHls = FakeHls.instances[0];
    controller.suspend(12.5);
    assert.equal(video.src, '');
    assert.ok(firstHls.calls.some(([name]) => name === 'destroy'));

    controller.resume();
    assert.equal(FakeHls.instances.length, 2);
    video.dispatch('loadedmetadata');
    assert.equal(video.currentTime, 12.5);
    FakeHls.instances[1].trigger(FakeHls.Events.MANIFEST_PARSED);
    assert.ok(FakeHls.instances[1].calls.some(([name]) => name === 'startLoad'));
    controller.destroy();
});

test('off-screen pause can keep the attached HLS instance and resume loading without resetting its buffer', () => {
    FakeHls.instances = [];
    const video = createVideoElement();
    const controller = createAdaptiveVideoPlaybackController(video, {
        HlsClass: FakeHls,
        getNetworkProfile: () => ({ profile: 'normal' }),
    });

    controller.attach(hlsSource, mp4Source);
    const hls = FakeHls.instances[0];
    hls.trigger(FakeHls.Events.MANIFEST_PARSED);
    controller.stopLoad();
    controller.startLoad(8.25);

    assert.equal(FakeHls.instances.length, 1);
    assert.equal(hls.calls.some(([name]) => name === 'destroy'), false);
    assert.deepEqual(hls.calls.filter(([name]) => name === 'startLoad').map(([, position]) => position), [0, 8.25]);
    controller.destroy();
});
