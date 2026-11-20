const bootstrapHasAuthenticatedUser = (bootstrapData) => {
    return bootstrapData?.auth?.status === true
        && bootstrapData?.auth?.user?.id !== undefined
        && bootstrapData?.auth?.user?.id !== null;
};

const isExpiredSessionStatus = (statusCode) => {
    return [401, 419].includes(Number(statusCode));
};

const shouldRetryAuthenticatedBootstrap = ({
    serverAuthenticated = false,
    bootstrapData = null,
    attemptIndex = 0,
    attemptCount = 1
} = {}) => {
    return Boolean(serverAuthenticated)
        && ! bootstrapHasAuthenticatedUser(bootstrapData)
        && Number(attemptIndex) + 1 < Math.max(1, Number(attemptCount) || 1);
};

const preserveServerAuthenticatedUser = ({
    bootstrapData = null,
    serverAuthenticated = false,
    serverAuthUser = null,
    serverAuthUserId = null,
    fallbackUser = null
} = {}) => {
    if (!serverAuthenticated) {
        return bootstrapData;
    }

    const expectedUserId = serverAuthUserId ?? serverAuthUser?.id ?? fallbackUser?.id ?? null;
    const bootstrapUser = bootstrapData?.auth?.user ?? null;

    if (bootstrapUser && (expectedUserId === null || String(bootstrapUser.id) === String(expectedUserId))) {
        return bootstrapData;
    }

    const preservedUser = [serverAuthUser, fallbackUser].find((user) => {
        if (!user || user.id === undefined || user.id === null) {
            return false;
        }

        return expectedUserId === null || String(user.id) === String(expectedUserId);
    });

    if (!preservedUser) {
        return bootstrapData;
    }

    return {
        ...(bootstrapData ?? {}),
        auth: {
            ...(bootstrapData?.auth ?? {}),
            status: true,
            user: preservedUser
        },
        home_feed: null
    };
};

export {
    bootstrapHasAuthenticatedUser,
    isExpiredSessionStatus,
    preserveServerAuthenticatedUser,
    shouldRetryAuthenticatedBootstrap
};
