const DEFAULT_ABR_ESTIMATES = {
    offline: 500_000,
    very_slow: 850_000,
    slow: 1_800_000,
    normal: 3_200_000,
    fast: 5_000_000,
};

export function getReelPlaybackStartupPolicy(networkProfile = {}) {
    const profile = String(networkProfile.profile || 'normal');
    const downlinkMbps = Number(networkProfile.downlinkMbps || 0);
    const saveData = Boolean(networkProfile.saveData);
    const defaultEstimate = saveData
        ? DEFAULT_ABR_ESTIMATES.very_slow
        : downlinkMbps > 0
            ? Math.max(850_000, Math.min(5_000_000, Math.round(downlinkMbps * 750_000)))
            : (DEFAULT_ABR_ESTIMATES[profile] || DEFAULT_ABR_ESTIMATES.normal);

    return {
        abrEwmaDefaultEstimate: defaultEstimate,
        preferredHeight: defaultEstimate >= 2_700_000 ? 720 : defaultEstimate >= 1_400_000 ? 480 : defaultEstimate >= 1_200_000 ? 360 : 240,
    };
}

export function getReelPreloadPolicy({ active = false, isNext = false, networkProfile = {} } = {}) {
    const mayPrefetch = !networkProfile.offline && !networkProfile.saveData;
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
