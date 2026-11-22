const MAX_POSTER_DATA_URL_LENGTH = 96_000;

export function captureVideoPoster(file, { seekSeconds = 0.12 } = {}) {
    if (!(file instanceof Blob) && typeof file !== 'string') return Promise.resolve('');
    if (typeof document === 'undefined') return Promise.resolve('');

    return new Promise(resolve => {
        const video = document.createElement('video');
        const url = file instanceof Blob ? URL.createObjectURL(file) : file;
        const isObjectUrl = file instanceof Blob;
        let settled = false;
        let timer;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.removeAttribute('src');
            video.load();
            if (isObjectUrl) URL.revokeObjectURL(url);
            resolve(value);
        };
        const capture = () => {
            if (!video.videoWidth || !video.videoHeight) return finish('');
            try {
                const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                const context = canvas.getContext('2d');
                if (!context) return finish('');
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                let poster = canvas.toDataURL('image/jpeg', 0.62);
                if (poster.length > MAX_POSTER_DATA_URL_LENGTH) poster = canvas.toDataURL('image/jpeg', 0.42);
                finish(poster.length <= MAX_POSTER_DATA_URL_LENGTH ? poster : '');
            } catch {
                finish('');
            }
        };

        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.onloadeddata = () => {
            if (video.duration > 0 && video.currentTime === 0) {
                const requestedSeconds = Number(seekSeconds);
                const targetSeconds = Math.min(video.duration, Math.max(0.12, Number.isFinite(requestedSeconds) ? requestedSeconds : 0.12));
                try { video.currentTime = targetSeconds; } catch { capture(); }
            } else capture();
        };
        video.onseeked = capture;
        video.onerror = () => finish('');
        timer = setTimeout(() => finish(''), 1800);
        video.src = url;
        video.load();
    });
}
