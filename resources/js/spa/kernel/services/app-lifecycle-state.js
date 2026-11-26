const STORAGE_KEY = 'zulors.app.lifecycle.v1';
const MAX_AGE_MS = 1000 * 60 * 60 * 24;

const canUseStorage = () => typeof window !== 'undefined' && Boolean(window.localStorage);

const readState = () => {
    if(! canUseStorage()) return null;

    try {
        const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
        if(! value || (Date.now() - Number(value.savedAt || 0)) > MAX_AGE_MS) return null;
        return value;
    }
    catch(error) {
        return null;
    }
};

const writeState = (state) => {
    if(! canUseStorage()) return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
            ...state,
            savedAt: Date.now(),
        }));
    }
    catch(error) {
        // Lifecycle state is an optimization and must never block navigation.
    }
};

const captureState = (router) => ({
    path: router?.currentRoute?.value?.fullPath || window.location.pathname + window.location.search,
    scrollX: Number(window.scrollX || 0),
    scrollY: Number(window.scrollY || 0),
});

function installAppLifecycleState(router, variant = 'web') {
    if(typeof window === 'undefined' || typeof document === 'undefined') return () => {};

    let disposed = false;
    const handleVisibilityChange = () => document.hidden ? save() : restore();
    const handleAppPause = () => save();
    const save = () => {
        if(! disposed) writeState({ ...captureState(router), variant });
    };
    const restore = () => {
        const state = readState();
        if(! state || state.path !== (router?.currentRoute?.value?.fullPath || window.location.pathname + window.location.search)) return;

        window.requestAnimationFrame?.(() => {
            window.scrollTo({ left: state.scrollX || 0, top: state.scrollY || 0, behavior: 'auto' });
            window.dispatchEvent(new CustomEvent('zulors:app-state-restore', { detail: state }));
        });
    };

    const rememberNativeRoute = (route) => {
        const bridge = window.ZulorsStartup;
        if(typeof bridge?.rememberSafeRoute !== 'function' || !route || !String(route).startsWith('/')) return;

        try {
            bridge.rememberSafeRoute(String(route));
        }
        catch(error) {
            // Native route persistence is a startup optimization only.
        }
    };

    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', restore);
    window.addEventListener('zulors:app-resume', restore);
    window.addEventListener('zulors:app-pause', handleAppPause);
    router?.afterEach?.((to) => {
        rememberNativeRoute(to?.fullPath || router.currentRoute?.value?.fullPath);
        window.requestIdleCallback?.(save) || window.setTimeout(save, 0);
    });

    return () => {
        disposed = true;
        window.removeEventListener('pagehide', save);
        window.removeEventListener('pageshow', restore);
        window.removeEventListener('zulors:app-resume', restore);
        window.removeEventListener('zulors:app-pause', handleAppPause);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
}

export { installAppLifecycleState, readState, writeState };
