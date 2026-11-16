export function getReelPreloadPolicy({ active = false, isNext = false, networkProfile = {} } = {}) {
    const mayPrefetch = !networkProfile.offline && !networkProfile.saveData;
    const prewarmingNext = !active && isNext && mayPrefetch;
    const slowProfile = ['offline', 'very_slow', 'slow'].includes(String(networkProfile.profile || ''));

    return {
        prewarmingNext,
        shouldWarm: Boolean(active || prewarmingNext),
        startLevel: prewarmingNext || slowProfile ? 0 : -1,
        autoLevelCapping: prewarmingNext ? 0 : -1,
        maxBufferLength: prewarmingNext ? 4 : Number(networkProfile.reelsMaxBufferLength || 16),
        maxMaxBufferLength: prewarmingNext ? 4 : Number(networkProfile.reelsMaxMaxBufferLength || 24),
    };
}

export function applyReelPreloadPolicy(hlsInstance, policy) {
    if (!hlsInstance || !policy) {
        return;
    }

    hlsInstance.autoLevelCapping = policy.autoLevelCapping;
    if (hlsInstance.config) {
        hlsInstance.config.maxBufferLength = policy.maxBufferLength;
        hlsInstance.config.maxMaxBufferLength = policy.maxMaxBufferLength;
    }
}
