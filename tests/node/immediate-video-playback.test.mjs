import test from 'node:test';
import assert from 'node:assert/strict';
import { canPlayVideoImmediately } from '../../resources/js/spa/kernel/services/media/immediate-video-playback.js';

const media = (overrides = {}) => ({
	id: 10,
	status: 'processing',
	preview_url: 'https://cdn.example.test/video.mp4',
	metadata: { provider: 'r2', upload_state: 'uploaded' },
	...overrides,
});

test('direct R2 uploaded media is playable before derived processing finishes', () => {
	assert.equal(canPlayVideoImmediately(media()), true);
});

test('canonical readiness canary hides raw upload until optimized MP4 is ready', () => {
	const canary = media({
		playback_ready: false,
		metadata: { provider: 'r2', upload_state: 'uploaded', playback_readiness: 'canonical_mp4', playback_state: 'processing' },
	});
	assert.equal(canPlayVideoImmediately(canary), false);
	assert.equal(canPlayVideoImmediately({
		...canary,
		source_url: 'https://cdn.example.test/optimized.mp4',
		playback_ready: true,
		metadata: { ...canary.metadata, playback_state: 'ready', processing_mode: 'optimized_mp4' },
	}), true);
});

test('canonical readiness overrides the legacy processed status during optimization', () => {
	assert.equal(canPlayVideoImmediately(media({
		status: 'processed',
		metadata: { provider: 'r2', upload_state: 'uploaded', playback_readiness: 'canonical_mp4', playback_state: 'processing' },
	})), false);
});

test('an explicit server playback_ready false overrides stale ready metadata', () => {
	assert.equal(canPlayVideoImmediately(media({
		playback_ready: false,
		status: 'processed',
		metadata: { provider: 'r2', upload_state: 'uploaded', playback_state: 'ready' },
	})), false);
});

test('processed media with a canonical source remains playable', () => {
	assert.equal(canPlayVideoImmediately(media({ status: 'processed', metadata: {} })), true);
});

test('explicit playback_ready media is playable regardless of processing label', () => {
	assert.equal(canPlayVideoImmediately(media({ playback_ready: true, metadata: {} })), true);
});

test('uploading media without a ready state does not mount a player', () => {
	assert.equal(canPlayVideoImmediately(media({ metadata: { provider: 'r2', upload_state: 'uploading' } })), false);
});

test('failed or URL-less media is never treated as playable', () => {
	assert.equal(canPlayVideoImmediately(media({ status: 'failed' })), false);
	assert.equal(canPlayVideoImmediately(media({ preview_url: '', source_url: '' })), false);
});
