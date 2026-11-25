export const REEL_RESUME_THRESHOLD_SECONDS = 30;

const STORAGE_KEY = 'zulors.reels.resume.v1';
const MAX_ENTRIES = 40;
const resumePositions = new Map();
let hydrated = false;

const canUseStorage = () => typeof window !== 'undefined' && Boolean(window.localStorage);

const normalizeMediaId = (mediaId) => {
	const normalized = String(mediaId || '').trim();

	return normalized || '';
};

const persist = () => {
	if(! canUseStorage()) {
		return;
	}

	try {
		const entries = [...resumePositions.entries()].slice(-MAX_ENTRIES);
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
	}
	catch(error) {
		// Resume state is an optimization and must never block playback.
	}
};

const hydrate = () => {
	if(hydrated) {
		return;
	}

	hydrated = true;

	if(! canUseStorage()) {
		return;
	}

	try {
		const entries = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
		if(! Array.isArray(entries)) {
			return;
		}

		entries.forEach(([mediaId, currentTime]) => {
			const normalizedMediaId = normalizeMediaId(mediaId);
			const normalizedPosition = normalizeReelResumePosition(currentTime);

			if(normalizedMediaId && normalizedPosition > 0) {
				resumePositions.set(normalizedMediaId, normalizedPosition);
			}
		});
	}
	catch(error) {
		// Ignore malformed or unavailable browser storage.
	}
};

export function normalizeReelResumePosition(currentTime) {
	const position = Number(currentTime);

	if(! Number.isFinite(position) || position < REEL_RESUME_THRESHOLD_SECONDS) {
		return 0;
	}

	return Math.round(position * 1000) / 1000;
}

export function getReelResumePosition(mediaId) {
	hydrate();

	return resumePositions.get(normalizeMediaId(mediaId)) || 0;
}

export function rememberReelResumePosition(mediaId, currentTime) {
	hydrate();

	const normalizedMediaId = normalizeMediaId(mediaId);
	const normalizedPosition = normalizeReelResumePosition(currentTime);

	if(! normalizedMediaId || normalizedPosition <= 0) {
		return getReelResumePosition(normalizedMediaId);
	}

	const nextPosition = Math.max(getReelResumePosition(normalizedMediaId), normalizedPosition);
	resumePositions.set(normalizedMediaId, nextPosition);

	while(resumePositions.size > MAX_ENTRIES) {
		resumePositions.delete(resumePositions.keys().next().value);
	}

	persist();

	return nextPosition;
}

export function clearReelResumePosition(mediaId) {
	hydrate();
	const removed = resumePositions.delete(normalizeMediaId(mediaId));

	if(removed) {
		persist();
	}

	return removed;
}

export function clearAllReelResumePositions() {
	resumePositions.clear();
	hydrated = true;
	persist();
}
