const handoffs = new Map();
let handoffSequence = 0;

const disposeHandoff = (handoff) => {
	if(! handoff?.controller) {
		return;
	}

	handoff.controller.discardHandoff?.(handoff);
};

export function retainReelPlaybackHandoff(mediaId, handoff, ttlMs = 12000) {
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
		}, Math.max(1000, Number(ttlMs) || 12000))
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
