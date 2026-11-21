import Hls from 'hls.js';
import { getNetworkProfileSnapshot } from '../../network/index.js';
import { applyReelStartupQualityPolicy, getReelPlaybackStartupPolicy } from '../reel-preload-policy.js';
import { canVideoElementPlayNatively, HLS_CONTENT_TYPE, shouldUseHlsJs } from './index.js';

export const hlsOptionsFor = (networkProfile) => ({
	autoStartLoad: false,
	enableWorker: true,
	capLevelToPlayerSize: false,
	lowLatencyMode: false,
	testBandwidth: false,
	backBufferLength: networkProfile?.reelsBackBufferLength ?? 6,
	startLevel: -1,
	abrEwmaDefaultEstimate: getReelPlaybackStartupPolicy(networkProfile).abrEwmaDefaultEstimate,
	maxBufferLength: networkProfile?.reelsMaxBufferLength ?? 12,
	maxMaxBufferLength: networkProfile?.reelsMaxMaxBufferLength ?? 18
});

export function createAdaptiveVideoPlaybackController(videoElement, options = {}) {
	const HlsClass = options.HlsClass || Hls;
	const getNetworkProfile = options.getNetworkProfile || getNetworkProfileSnapshot;
	let hlsInstance = null;
	let source = null;
	let fallbackSource = null;
	let networkRetries = 0;
	let mediaRetries = 0;
	let loadRequested = false;
	let manifestReady = false;
	let destroyed = false;
	let resumePosition = 0;
	let nativeErrorHandler = null;
	let handoffDetached = false;
	let handoffRetained = false;

	const releaseHls = () => {
		if(! hlsInstance) {
			return;
		}

		try {
			hlsInstance.destroy();
		}
		catch(error) {}

		hlsInstance = null;
		manifestReady = false;
	};

	const clearVideoSource = () => {
		if(! videoElement) {
			return;
		}

		videoElement.pause?.();
		if(nativeErrorHandler) {
			videoElement.removeEventListener?.('error', nativeErrorHandler);
			nativeErrorHandler = null;
		}
		videoElement.removeAttribute?.('src');
		videoElement.load?.();
	};

	const attach = (nextSource, nextFallback = null) => {
		if(destroyed || ! videoElement || ! nextSource?.url) {
			return false;
		}

		releaseHls();
		clearVideoSource();
		source = nextSource;
		fallbackSource = nextFallback?.url && nextFallback.url !== nextSource.url ? nextFallback : null;
		networkRetries = 0;
		mediaRetries = 0;

		const canUseNativeHls = nextSource.transport === 'hls'
			&& canVideoElementPlayNatively(videoElement, nextSource.type || HLS_CONTENT_TYPE);
		// Prefer HLS.js whenever MSE is available so startLevel and the HD
		// bitrate floor also apply on browsers that advertise native HLS.
		const useHlsJs = shouldUseHlsJs(nextSource, HlsClass);

		if(nextSource.transport === 'hls' && ! canUseNativeHls && ! useHlsJs) {
			if(! fallbackSource) {
				options.onFatalError?.({ type: 'unsupported_hls', fatal: true });
				return false;
			}

			const directSource = fallbackSource;
			fallbackSource = null;
			options.onFallback?.();

			return attach(directSource);
		}

		if(! useHlsJs) {
			videoElement.preload = 'metadata';
			if(canUseNativeHls && fallbackSource) {
				nativeErrorHandler = () => {
					const directSource = fallbackSource;
					if(! directSource) {
						return;
					}
					fallbackSource = null;
					options.onFallback?.();
					attach(directSource);
				};
				videoElement.addEventListener?.('error', nativeErrorHandler, { once: true });
			}
			videoElement.src = nextSource.url;
			videoElement.load?.();

			return true;
		}

		const instance = new HlsClass(hlsOptionsFor(getNetworkProfile()));
		hlsInstance = instance;
		manifestReady = false;
		const startHlsLoad = (position = resumePosition || Number(videoElement.currentTime || 0)) => {
			if(hlsInstance !== instance || ! manifestReady) {
				return;
			}

			instance.startLoad(position);
		};

		const useFallback = () => {
			if(hlsInstance !== instance || ! fallbackSource?.url) {
				return false;
			}

			const directSource = fallbackSource;
			fallbackSource = null;
			releaseHls();
			options.onFallback?.();

			return attach(directSource);
		};

		instance.on(HlsClass.Events.ERROR, (event, data = {}) => {
			if(hlsInstance !== instance || ! data.fatal) {
				return;
			}

			if(data.type === HlsClass.ErrorTypes.NETWORK_ERROR && networkRetries < 1) {
				networkRetries += 1;
				try {
					startHlsLoad(Number(videoElement.currentTime || 0));
					return;
				}
				catch(error) {}
			}

			if(data.type === HlsClass.ErrorTypes.MEDIA_ERROR && mediaRetries < 1) {
				mediaRetries += 1;
				try {
					instance.recoverMediaError();
					return;
				}
				catch(error) {}
			}

			if(! useFallback()) {
				options.onFatalError?.(data);
			}
		});

		if(HlsClass.Events.LEVEL_SWITCHED) {
			instance.on(HlsClass.Events.LEVEL_SWITCHED, (event, data = {}) => {
				const height = instance.levels?.[data.level]?.height || 0;
				if(height > 0) {
					options.onRendition?.(height);
				}
			});
		}

		instance.on(HlsClass.Events.MEDIA_ATTACHED, () => {
			if(hlsInstance !== instance) {
				return;
			}

			if(! instance.url) {
				instance.loadSource(nextSource.url);
			}
		});
		instance.on(HlsClass.Events.MANIFEST_PARSED, () => {
			if(hlsInstance !== instance) {
				return;
			}

			manifestReady = true;
			applyReelStartupQualityPolicy(
				instance,
				getReelPlaybackStartupPolicy(getNetworkProfile()).preferredShortEdge
			);

			if(loadRequested) {
				startHlsLoad();
			}
		});
		instance.attachMedia(videoElement);

		return true;
	};

	return {
		setSource(nextSource, nextFallback = null) {
			source = nextSource?.url ? nextSource : null;
			fallbackSource = nextFallback?.url && nextFallback.url !== nextSource?.url ? nextFallback : null;
		},
		attach(nextSource, nextFallback = null) {
			loadRequested = true;
			return attach(nextSource, nextFallback);
		},
		startLoad(startPosition = Number(videoElement?.currentTime || 0)) {
			loadRequested = true;
			try {
				if(manifestReady) {
					hlsInstance?.startLoad(startPosition);
				}
			}
			catch(error) {}
		},
		setCallbacks(callbacks = {}) {
			Object.assign(options, callbacks);
		},
		getHlsInstance() {
			return hlsInstance;
		},
		isHandedOff() {
			return handoffRetained;
		},
		detachForHandoff() {
			if(destroyed || !hlsInstance || !videoElement || source?.transport !== 'hls') {
				return null;
			}

			try {
				hlsInstance.stopLoad();
				const transferData = hlsInstance.transferMedia();
				if(!transferData) {
					return null;
				}

				handoffDetached = true;
				handoffRetained = true;

				return {
					controller: this,
					hlsInstance,
					transferData,
					oldVideoElement: videoElement,
					currentTime: Number(videoElement.currentTime || 0),
					source,
					fallbackSource,
				};
			}
			catch(error) {
				return null;
			}
		},
		attachTransferredMedia(handoff, nextVideoElement) {
			if(destroyed || !handoff || handoff.controller !== this || handoff.hlsInstance !== hlsInstance || !nextVideoElement) {
				return false;
			}

			const oldVideoElement = handoff.oldVideoElement;
			const transferredSrc = oldVideoElement?.currentSrc || oldVideoElement?.src || '';
			if(!transferredSrc) {
				return false;
			}

			try {
				nextVideoElement.src = transferredSrc;
				videoElement = nextVideoElement;
				hlsInstance.attachMedia({
					...handoff.transferData,
					media: nextVideoElement,
				});
				handoffDetached = false;
				loadRequested = true;

				const restorePosition = () => {
					if(handoff.currentTime > 0 && Math.abs(Number(nextVideoElement.currentTime || 0) - handoff.currentTime) > 0.5) {
						try {
							nextVideoElement.currentTime = handoff.currentTime;
						}
						catch(error) {}
					}
				};

				if(nextVideoElement.readyState >= 1) {
					restorePosition();
				}
				else {
					nextVideoElement.addEventListener('loadedmetadata', restorePosition, { once: true });
				}
				this.startLoad(handoff.currentTime);

				oldVideoElement?.pause?.();
				if(oldVideoElement && oldVideoElement !== nextVideoElement) {
					oldVideoElement.removeAttribute?.('src');
					oldVideoElement.load?.();
				}

				return true;
			}
			catch(error) {
				return false;
			}
		},
		restoreFromHandoff(handoff) {
			if(!handoff?.oldVideoElement) {
				return false;
			}

			return this.attachTransferredMedia(handoff, handoff.oldVideoElement);
		},
		discardHandoff(handoff) {
			if(handoff?.controller !== this || handoff.hlsInstance !== hlsInstance) {
				return false;
			}

			if(handoffDetached && ! this.restoreFromHandoff(handoff)) {
				handoffDetached = false;
			}

			this.destroy();

			return true;
		},
		stopLoad() {
			loadRequested = false;
			try {
				hlsInstance?.stopLoad();
			}
			catch(error) {}
		},
		suspend(startPosition = Number(videoElement?.currentTime || 0)) {
			resumePosition = Number.isFinite(startPosition) ? Math.max(0, startPosition) : 0;
			loadRequested = false;
			releaseHls();
			clearVideoSource();
		},
		resume() {
			if(! source?.url || destroyed) {
				return false;
			}

			loadRequested = true;
			const resumed = attach(source, fallbackSource);
			if(resumed && resumePosition > 0) {
				const seekToResumePosition = () => {
					try {
						videoElement.currentTime = resumePosition;
					}
					catch(error) {}
				};
				videoElement.addEventListener?.('loadedmetadata', seekToResumePosition, { once: true });
			}
			return resumed;
		},
		destroy() {
			if(handoffDetached) {
				return;
			}

			destroyed = true;
			handoffRetained = false;
			loadRequested = false;
			source = null;
			fallbackSource = null;
			releaseHls();
			clearVideoSource();
		}
	};
}
