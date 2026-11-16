const bootstrapHasAuthenticatedUser = (bootstrapData) => {
    return bootstrapData?.auth?.status === true
        && bootstrapData?.auth?.user?.id !== undefined
        && bootstrapData?.auth?.user?.id !== null;
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

export {
    bootstrapHasAuthenticatedUser,
    shouldRetryAuthenticatedBootstrap
};
