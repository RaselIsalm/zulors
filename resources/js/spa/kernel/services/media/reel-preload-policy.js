const DEFAULT_ABR_ESTIMATES = {
    offline: 300_000,
    very_slow: 850_000,
    slow: 1_800_000,
    normal: 5_000_000,
    fast: 8_000_000,
};

export function getReelPlaybackStartupPolicy(networkProfile = {}) {
    const profile = String(networkProfile.profile || 'normal');
    const downlinkMbps = Number(networkProfile.downlinkMbps || 0);
    const saveData = Boolean(networkProfile.saveData);
    const defaultEstimate = saveData
        ? DEFAULT_ABR_ESTIMATES.very_slow
        : downlinkMbps > 0
            ? Math.max(850_000, Math.min(8_000_000, Math.round(downlinkMbps * 900_000)))
            : (DEFAULT_ABR_ESTIMATES[profile] || DEFAULT_ABR_ESTIMATES.normal);

    return {
        abrEwmaDefaultEstimate: defaultEstimate,
        preferredHeight: defaultEstimate >= 7_800_000 ? 1080 : defaultEstimate >= 4_400_000 ? 720 : defaultEstimate >= 2_400_000 ? 480 : defaultEstimate >= 1_400_000 ? 360 : 240,
    };
}

export function getPreferredReelLevelIndex(levels = [], preferredHeight = 720) {
    if(! Array.isArray(levels) || levels.length === 0) {
        return -1;
    }

    const usableLevels = levels
        .map((level, index) => ({ index, height: Number(level?.height || 0), bitrate: Number(level?.maxBitrate || level?.bitrate || 0) }))
        .filter((level) => level.height > 0);
    const atOrBelowTarget = usableLevels.filter((level) => level.height <= Number(preferredHeight || 0));
    usableLevels.sort((left, right) => left.height - right.height || left.bitrate - right.bitrate);

    if(atOrBelowTarget.length === 0) {
        return usableLevels[0]?.index ?? -1;
    }

    atOrBelowTarget.sort((left, right) => left.height - right.height || left.bitrate - right.bitrate);

    return atOrBelowTarget[atOrBelowTarget.length - 1]?.index ?? -1;
}

export function getReelPreloadPolicy({ active = false, isNext = false, networkProfile = {} } = {}) {
    const mayPrefetch = !networkProfile.offline && !networkProfile.saveData && networkProfile.allowVideoPrefetch !== false;
    const prewarmingNext = !active && isNext && mayPrefetch;
    const startupPolicy = getReelPlaybackStartupPolicy(networkProfile);

    return {
        prewarmingNext,
        shouldWarm: Boolean(active || prewarmingNext),
        startLevel: -1,
        abrEwmaDefaultEstimate: startupPolicy.abrEwmaDefaultEstimate,
        preferredHeight: startupPolicy.preferredHeight,
        autoLevelCapping: -1,
        maxBufferLength: prewarmingNext ? 4 : Number(networkProfile.reelsMaxBufferLength || 16),
        maxMaxBufferLength: prewarmingNext ? 4 : Number(networkProfile.reelsMaxMaxBufferLength || 24),
    };
}

export function applyReelPreloadPolicy(hlsInstance, policy) {
    if (!hlsInstance || !policy) {
        return;
    }

    hlsInstance.autoLevelCapping = policy.autoLevelCapping;
    if (Number.isFinite(Number(policy.abrEwmaDefaultEstimate))) {
        hlsInstance.abrEwmaDefaultEstimate = Number(policy.abrEwmaDefaultEstimate);
    }
    if (hlsInstance.config) {
        hlsInstance.config.maxBufferLength = policy.maxBufferLength;
        hlsInstance.config.maxMaxBufferLength = policy.maxMaxBufferLength;
    }
}
