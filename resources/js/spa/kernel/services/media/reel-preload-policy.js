const DEFAULT_ABR_ESTIMATES = {
    offline: 300_000,
    very_slow: 850_000,
    slow: 1_800_000,
    normal: 5_000_000,
    fast: 8_000_000,
};
const HD_STARTUP_ESTIMATE = 5_000_000;

export function getReelPlaybackStartupPolicy(networkProfile = {}) {
    const profile = String(networkProfile.profile || 'normal');
    const downlinkMbps = Number(networkProfile.downlinkMbps || 0);
    const saveData = Boolean(networkProfile.saveData);
    const networkEstimate = saveData
        ? DEFAULT_ABR_ESTIMATES.very_slow
        : downlinkMbps > 0
            ? Math.max(850_000, Math.min(8_000_000, Math.round(downlinkMbps * 900_000)))
            : (DEFAULT_ABR_ESTIMATES[profile] || DEFAULT_ABR_ESTIMATES.normal);
    // Network Information API downlink is a coarse estimate, not measured
    // throughput. Use it only to choose whether to start above HD; HLS.js will
    // adapt down after it measures actual segment throughput.
    const defaultEstimate = Math.max(HD_STARTUP_ESTIMATE, networkEstimate);

    return {
        abrEwmaDefaultEstimate: defaultEstimate,
        preferredShortEdge: defaultEstimate >= 7_800_000 ? 1080 : 720,
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
                bitrate: Number(level?.maxBitrate || level?.bitrate || 0),
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

export function getMinimumReelAutoBitrate(levels = [], minimumShortEdge = 720) {
    if(! Array.isArray(levels) || levels.length === 0) {
        return 0;
    }

    const hdLevels = levels
        .map((level) => {
            const width = Number(level?.width || 0);
            const height = Number(level?.height || 0);

            return {
                shortEdge: width > 0 && height > 0 ? Math.min(width, height) : height,
                bitrate: Number(level?.maxBitrate || level?.bitrate || 0),
            };
        })
        .filter((level) => level.shortEdge >= minimumShortEdge && level.bitrate > 0)
        .sort((left, right) => left.shortEdge - right.shortEdge || left.bitrate - right.bitrate);

    return hdLevels[0]?.bitrate ?? 0;
}

export function applyReelStartupQualityPolicy(hlsInstance, preferredShortEdge = 720) {
    if(! hlsInstance) {
        return { preferredLevel: -1, minAutoBitrate: 0 };
    }

    const preferredLevel = getPreferredReelLevelIndex(hlsInstance.levels || [], preferredShortEdge);
    const minAutoBitrate = getMinimumReelAutoBitrate(hlsInstance.levels || []);

    if(preferredLevel >= 0) {
        hlsInstance.startLevel = preferredLevel;
    }

    // Keep automatic switching within HD once an HD rendition is available.
    // Smaller sources have no HD rung, so their ABR range stays unrestricted.
    if(hlsInstance.config) {
        hlsInstance.config.minAutoBitrate = minAutoBitrate;
    }

    return { preferredLevel, minAutoBitrate };
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
        preferredShortEdge: startupPolicy.preferredShortEdge,
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
