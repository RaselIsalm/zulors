const DEFAULT_ABR_ESTIMATES = {
	offline: 300_000,
	very_slow: 850_000,
	slow: 1_800_000,
	normal: 5_000_000,
	fast: 8_000_000,
};

const MIN_STARTUP_ESTIMATE = 500_000;
export const REEL_STARTUP_BUFFER_SECONDS = 5;
export const REEL_STARTUP_HD_WAIT_MS = 10_000;
export const REEL_NEXT_BUFFER_SECONDS = 2;
export const REEL_STALL_INDICATOR_DELAY_MS = 2_000;

export function getRequiredStartupBufferSeconds(durationSeconds, currentTime = 0, targetSeconds = REEL_STARTUP_BUFFER_SECONDS) {
	const target = Math.max(0, Number(targetSeconds) || 0);
	const duration = Number(durationSeconds);
	const position = Math.max(0, Number(currentTime) || 0);
	const remaining = Number.isFinite(duration) && duration > 0
		? Math.max(0, duration - position)
		: target;

	return Math.min(target, remaining);
}

export function getReelPlaybackStartupPolicy(networkProfile = {}) {
	const profile = String(networkProfile.profile || 'normal');
	const downlinkMbps = Number(networkProfile.downlinkMbps || 0);
	const saveData = Boolean(networkProfile.saveData);
	const networkEstimate = saveData
		? DEFAULT_ABR_ESTIMATES.very_slow
		: downlinkMbps > 0
			? Math.max(850_000, Math.min(8_000_000, Math.round(downlinkMbps * 900_000)))
			: (DEFAULT_ABR_ESTIMATES[profile] || DEFAULT_ABR_ESTIMATES.normal);

	return {
		abrEwmaDefaultEstimate: Math.max(MIN_STARTUP_ESTIMATE, networkEstimate),
		// Prefer a crisp HD first frame; the buffer deadline applies a sustainable rung if needed.
		preferredShortEdge: 720,
	};
}

export function getPreferredReelLevelIndex(levels = [], preferredShortEdge = 720) {
	if(! Array.isArray(levels) || levels.length === 0) {
		return -1;
	}

	const usableLevels = levels
		.map((level, index) => {
			const width = Number(level?.width || 0);
			const height = Number(level?.height || 0);

			return {
				index,
				shortEdge: width > 0 && height > 0 ? Math.min(width, height) : height,
				bitrate: Number(level?.bitrate || level?.maxBitrate || 0),
			};
		})
		.filter((level) => level.shortEdge > 0);
	const atOrBelowTarget = usableLevels.filter((level) => level.shortEdge <= Number(preferredShortEdge || 0));
	usableLevels.sort((left, right) => left.shortEdge - right.shortEdge || left.bitrate - right.bitrate);

	if(atOrBelowTarget.length === 0) {
		return usableLevels[0]?.index ?? -1;
	}

	atOrBelowTarget.sort((left, right) => left.shortEdge - right.shortEdge || left.bitrate - right.bitrate);

	return atOrBelowTarget[atOrBelowTarget.length - 1]?.index ?? -1;
}

export function getSustainableReelLevelIndex(levels = [], bandwidthEstimate = 0, safetyFactor = 0.75) {
	if(! Array.isArray(levels) || levels.length === 0) {
		return -1;
	}

	const usableLevels = levels
		.map((level, index) => ({
			index,
			shortEdge: Number(level?.width || 0) > 0 && Number(level?.height || 0) > 0
				? Math.min(Number(level.width), Number(level.height))
				: Number(level?.height || 0),
			bitrate: Number(level?.bitrate || level?.maxBitrate || 0),
		}))
		.filter((level) => level.shortEdge > 0);

	if(! usableLevels.length) {
		return -1;
	}

	usableLevels.sort((left, right) => left.bitrate - right.bitrate || left.shortEdge - right.shortEdge);
	const estimate = Number(bandwidthEstimate || 0);
	const sustainable = estimate > 0
		? usableLevels.filter((level) => level.bitrate > 0 && level.bitrate <= estimate * safetyFactor)
		: [];

	return (sustainable[sustainable.length - 1] || usableLevels[0]).index;
}

export function applyReelStartupQualityPolicy(hlsInstance, preferredShortEdge = 720, bandwidthEstimate = 0) {
	if(! hlsInstance) {
		return { preferredLevel: -1, minAutoBitrate: 0 };
	}

	const levels = hlsInstance.levels || [];
	const preferredLevel = getPreferredReelLevelIndex(levels, preferredShortEdge);
	const preferredBitrate = preferredLevel >= 0
		? Number(levels[preferredLevel]?.bitrate || levels[preferredLevel]?.maxBitrate || 0)
		: 0;
	const estimate = Number(bandwidthEstimate || hlsInstance.bandwidthEstimate || hlsInstance.abrEwmaDefaultEstimate || 0);
	// A 720p-first request is useful on normal/fast networks, but forcing a
	// rung that needs materially more bandwidth than the measured connection
	// makes startup slower than the quality gain. Pick the highest sustainable
	// rung only when the preferred rung cannot be sustained with headroom.
	const startupLevel = preferredLevel >= 0
		&& preferredBitrate > 0
		&& estimate > 0
		&& preferredBitrate > estimate * 1.25
		? getSustainableReelLevelIndex(levels, estimate)
		: preferredLevel;
	const minAutoBitrate = 0;

	if(startupLevel >= 0) {
		hlsInstance.startLevel = startupLevel;
	}

	if(hlsInstance.config) {
		hlsInstance.config.minAutoBitrate = minAutoBitrate;
	}

	return { preferredLevel: startupLevel, requestedLevel: preferredLevel, minAutoBitrate };
}

export function applyReelPreloadPolicy(hlsInstance, policy) {
	if(! hlsInstance || ! policy) {
		return;
	}

	hlsInstance.autoLevelCapping = policy.autoLevelCapping;
	if(Number.isFinite(Number(policy.abrEwmaDefaultEstimate))) {
		hlsInstance.abrEwmaDefaultEstimate = Number(policy.abrEwmaDefaultEstimate);
	}
	if(hlsInstance.config) {
		hlsInstance.config.maxBufferLength = policy.maxBufferLength;
		hlsInstance.config.maxMaxBufferLength = policy.maxMaxBufferLength;
	}
}

export function getReelPreloadPolicy({ active = false, isNext = false, distanceFromActive = isNext ? 1 : 0, networkProfile = {} } = {}) {
	const mayPrefetch = !networkProfile.offline && !networkProfile.saveData;
	const lookaheadLimit = networkProfile.profile === 'slow' || networkProfile.profile === 'very_slow' ? 1 : 2;
	const prewarmingNext = !active && distanceFromActive > 0 && distanceFromActive <= lookaheadLimit && mayPrefetch;
	const startupPolicy = getReelPlaybackStartupPolicy(networkProfile);

	return {
		prewarmingNext,
		shouldWarm: Boolean(active || prewarmingNext),
		startLevel: -1,
		abrEwmaDefaultEstimate: startupPolicy.abrEwmaDefaultEstimate,
		preferredShortEdge: startupPolicy.preferredShortEdge,
		startupBufferSeconds: REEL_STARTUP_BUFFER_SECONDS,
		startupHdWaitMs: REEL_STARTUP_HD_WAIT_MS,
		nextBufferSeconds: REEL_NEXT_BUFFER_SECONDS,
		stallIndicatorDelayMs: REEL_STALL_INDICATOR_DELAY_MS,
		autoLevelCapping: -1,
		maxBufferLength: prewarmingNext ? 3 : Number(networkProfile.reelsMaxBufferLength || 16),
		maxMaxBufferLength: prewarmingNext ? 3 : Number(networkProfile.reelsMaxMaxBufferLength || 24),
	};
}
