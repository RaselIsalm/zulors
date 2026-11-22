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

    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => document.hidden ? save() : restore());
    window.addEventListener('pageshow', restore);
    window.addEventListener('zulors:app-resume', restore);
    router?.afterEach?.(() => window.requestIdleCallback?.(save) || window.setTimeout(save, 0));

    return () => {
        disposed = true;
        window.removeEventListener('pagehide', save);
        window.removeEventListener('pageshow', restore);
        window.removeEventListener('zulors:app-resume', restore);
    };
}

export { installAppLifecycleState, readState, writeState };
