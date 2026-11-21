import test from 'node:test';
import assert from 'node:assert/strict';

import { createAdaptiveVideoPlaybackController } from '../../resources/js/spa/kernel/services/media/adaptive-video/playback.js';
import {
	retainReelPlaybackHandoff,
	takeReelPlaybackHandoff,
} from '../../resources/js/spa/kernel/services/media/reel-playback-handoff.js';

const events = {
	MEDIA_ATTACHED: 'mediaAttached',
	MANIFEST_PARSED: 'manifestParsed',
	LEVEL_SWITCHED: 'levelSwitched',
	ERROR: 'error',
};

class FakeVideoElement {
	constructor() {
		this.src = '';
		this.currentSrc = '';
		this.currentTime = 0;
		this.readyState = 0;
		this.paused = true;
		this.listeners = new Map();
		this.loadCount = 0;
	}

	set src(value) {
		this._src = value;
		this.currentSrc = value;
	}

	get src() {
		return this._src || '';
	}

	pause() {
		this.paused = true;
	}

	load() {
		this.loadCount += 1;
	}

	removeAttribute(name) {
		if(name === 'src') {
			this.src = '';
		}
	}

	addEventListener(name, listener) {
		this.listeners.set(name, listener);
	}
}

class FakeHls {
	static Events = events;
	static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
	static isSupported() { return true; }

	constructor(config) {
		this.config = config;
		this.listeners = new Map();
		this.levels = [{ width: 640, height: 360, bitrate: 500_000 }];
		this.url = null;
		this.destroyed = false;
	}

	on(name, listener) {
		const listeners = this.listeners.get(name) || [];
		listeners.push(listener);
		this.listeners.set(name, listeners);
	}

	off(name, listener) {
		this.listeners.set(name, (this.listeners.get(name) || []).filter((current) => current !== listener));
	}

	emit(name, data = {}) {
		(this.listeners.get(name) || []).forEach((listener) => listener(name, data));
	}

	attachMedia(data) {
		this.media = data?.media || data;
		this.attachingData = data;
		this.emit(events.MEDIA_ATTACHED);
	}

	loadSource(url) {
		this.url = url;
	}

	startLoad(position) {
		this.startedAt = position;
	}

	stopLoad() {
		this.stopped = true;
	}

	transferMedia() {
		return { mediaSource: { transferred: true }, tracks: {} };
	}

	recoverMediaError() {}

	destroy() {
		this.destroyed = true;
	}
}

test('feed HLS playback transfers its MediaSource and buffered controller to Reels', () => {
	const feedVideo = new FakeVideoElement();
	const reelsVideo = new FakeVideoElement();
	const controller = createAdaptiveVideoPlaybackController(feedVideo, {
		HlsClass: FakeHls,
		getNetworkProfile: () => ({ profile: 'normal' }),
	});
	const source = {
		url: 'https://media.example.test/reel.m3u8',
		transport: 'hls',
		type: 'application/vnd.apple.mpegurl',
	};

	assert.equal(controller.attach(source), true);
	const hls = controller.getHlsInstance();
	hls.emit(events.MANIFEST_PARSED);
	feedVideo.src = 'blob:feed-media-source';
	feedVideo.currentTime = 12.5;

	const handoff = controller.detachForHandoff();
	assert.ok(handoff);
	assert.equal(controller.isHandedOff(), true);
	assert.equal(controller.destroy(), undefined);
	assert.equal(hls.destroyed, false);

	assert.equal(controller.attachTransferredMedia(handoff, reelsVideo), true);
	assert.equal(controller.isHandedOff(), true);
	assert.equal(hls.media, reelsVideo);
	assert.equal(hls.url, source.url);
	assert.equal(hls.startedAt, 12.5);
	assert.equal(reelsVideo.src, 'blob:feed-media-source');
	assert.equal(feedVideo.src, '');

	controller.destroy();
	assert.equal(controller.isHandedOff(), false);
	assert.equal(hls.destroyed, true);
});

test('playback handoff tokens are single-use and validate the media id', () => {
	const handoff = { controller: { discardHandoff() {} } };
	const token = retainReelPlaybackHandoff(42, handoff);

	assert.equal(takeReelPlaybackHandoff(token, 7), null);
	assert.equal(takeReelPlaybackHandoff(token, 42), handoff);
	assert.equal(takeReelPlaybackHandoff(token, 42), null);
});
