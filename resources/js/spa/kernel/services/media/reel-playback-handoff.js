import { normalizeReelResumePosition } from './reel-resume-state.js';

const handoffs = new Map();
let handoffSequence = 0;

/**
 * Keep the feed-to-Reels playback envelope identical on desktop and mobile.
 * Playback position is client state; it must remain finite and non-negative
 * even when a browser reports an invalid value during source replacement.
 */
export function normalizeReelPlaybackState(playbackState = {}, fallbackMediaId = null) {
	const rawCurrentTime = Number(playbackState?.currentTime || 0);
	const rawStartedAt = Number(playbackState?.startedAt || 0);
	const currentTime = Number.isFinite(rawCurrentTime)
		? normalizeReelResumePosition(rawCurrentTime)
		: 0;

	return {
		mediaId: playbackState?.mediaId || fallbackMediaId || null,
		handoffToken: String(playbackState?.handoffToken || ''),
		currentTime,
		startedAt: Number.isFinite(rawStartedAt) && rawStartedAt > 0 ? rawStartedAt : Date.now(),
		wasPlaying: Boolean(playbackState?.wasPlaying),
	};
}

const disposeHandoff = (handoff) => {
	if(! handoff?.controller) {
		return;
	}

	handoff.controller.discardHandoff?.(handoff);
};

export function retainReelPlaybackHandoff(mediaId, handoff, ttlMs = 30000) {
	if(! mediaId || ! handoff?.controller) {
		return '';
	}

	const token = `reel-handoff-${Date.now().toString(36)}-${(++handoffSequence).toString(36)}`;
	const entry = {
		mediaId: String(mediaId),
		handoff,
		timer: setTimeout(() => {
			if(handoffs.get(token) !== entry) {
				return;
			}

			handoffs.delete(token);
			disposeHandoff(handoff);
		}, Math.max(1000, Number(ttlMs) || 30000))
	};

	handoffs.set(token, entry);

	return token;
}

export function takeReelPlaybackHandoff(token, mediaId) {
	const entry = handoffs.get(String(token || ''));
	if(! entry || entry.mediaId !== String(mediaId || '')) {
		return null;
	}

	clearTimeout(entry.timer);
	handoffs.delete(String(token));

	return entry.handoff;
}

export function discardReelPlaybackHandoff(token) {
	const normalizedToken = String(token || '');
	const entry = handoffs.get(normalizedToken);
	if(! entry) {
		return false;
	}

	clearTimeout(entry.timer);
	handoffs.delete(normalizedToken);
	disposeHandoff(entry.handoff);

	return true;
}
