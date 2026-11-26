<template>
    <div class="story-media-stage">
        <StoryMediaLoader v-show="isLoading || hasError" class="absolute inset-0 z-20" v-bind:lqipBase64="previewUrl" v-bind:showSpinner="isLoading && !hasError"></StoryMediaLoader>
        <div v-if="hasError" class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-black/45 px-6 text-center text-white">
            <p class="text-sm">{{ errorMessage }}</p>
            <button type="button" class="rounded-full bg-white px-4 py-2 text-xs font-semibold text-black" v-on:click="retryMedia">Retry</button>
        </div>
        <video
            v-if="showBlurBackdrop && mediaSourceUrl && !hlsUrl"
            ref="storyBackdropVideo"
            v-bind:src="hlsUrl ? null : mediaSourceUrl"
            class="story-media-backdrop"
            webkit-playsinline
            playsinline
            muted
            preload="metadata"
            aria-hidden="true"
            tabindex="-1"
        ></video>
        <div v-if="showBlurBackdrop && !hlsUrl" class="story-media-backdrop-shade"></div>
        <video
            v-bind:key="reloadToken"
            v-show="! isLoading && !hasError"
            ref="storyVideo"
            v-bind:src="hlsUrl ? null : mediaSourceUrl"
            v-bind:poster="previewUrl"
            v-bind:class="foregroundFitClass"
            v-on:loadedmetadata="handleLoadedMetadata"
            v-on:loadeddata="onLoaded"
            v-on:error="onMediaError"
            v-on:play="syncBackdropVideo"
            v-on:pause="syncBackdropVideo"
            v-on:timeupdate="syncBackdropVideo"
            class="story-media-foreground"
            webkit-playsinline
            playsinline
            preload="metadata"
        >
            <source v-if="! hlsUrl" v-bind:src="mediaSourceUrl" v-bind:type="frameData.media.mime || 'video/mp4'">
        </video>
    </div>
</template>
<script>
    import { computed, defineComponent, ref, inject, onMounted, watch, onBeforeUnmount, nextTick } from 'vue';
    import { colibriEventBus } from '@/kernel/events/bus/index.js';
    import { elementVideoDimensions, shouldUseStoryBlurBackdrop, storyMediaObjectFitClass } from '@/kernel/services/media/story-media-presentation.js';
    import { frameHasStoryMusic } from '@/kernel/services/media/story-music-playback.js';
    import { createAdaptiveVideoPlaybackController } from '@/kernel/services/media/adaptive-video/playback.js';
    import { buildAdaptiveVideoSource, getDirectPlaybackFallback } from '@/kernel/services/media/adaptive-video/index.js';
    import StoryMediaLoader from '@D/views/stories/parts/media/StoryMediaLoader.vue';

    export default defineComponent({
        props: {
            frameData: {
                type: Object,
                required: true
            }
        },
        setup: function(props) {
            const storyVideo = ref(null);
            const storyBackdropVideo = ref(null);
            const isLoading = ref(true);
            const hasError = ref(false);
            const reloadToken = ref(0);
            const frameData = ref(props.frameData);
            const playerState = inject('playerState');
            const loadedDimensions = ref({});
            let playbackController = null;
            const mediaItem = computed(() => {
                return frameData.value.media || {};
            });
            const mediaSourceUrl = computed(() => {
                return mediaItem.value.source_url || mediaItem.value.preview_url || '';
            });
            const hlsUrl = computed(() => {
                const playback = mediaItem.value.metadata?.playback || {};
                return playback.hls_state === 'ready' ? String(playback.hls || '') : '';
            });
            const previewUrl = computed(() => mediaItem.value.lqip_base64 || mediaItem.value.thumbnail_url || '');
            const errorMessage = computed(() => mediaSourceUrl.value
                ? 'This video could not be played.'
                : 'This video is still being prepared.');

            watch(mediaSourceUrl, (url) => {
                if (!url) {
                    isLoading.value = false;
                    hasError.value = true;
                }
            }, { immediate: true });
            
            onMounted(() => {
                if (hasAttachedMusic() || localStorage.getItem('stories_videos_muted')) {
                    storyVideo.value.muted = true;
                }
                else{
                    storyVideo.value.muted = false;
                }

                watch(() => { return playerState.isPaused; }, () => {
                    pauseToggle();
                });

                colibriEventBus.on('story:unmute', unmuteVideo);

                colibriEventBus.on('story:mute', muteVideo);

                attachAdaptiveSource();
            });

            onBeforeUnmount(() => {
                colibriEventBus.off('story:unmute', unmuteVideo);
                colibriEventBus.off('story:mute', muteVideo);
                playbackController?.destroy();
                playbackController = null;
            });

            const attachAdaptiveSource = () => {
                if(! hlsUrl.value || ! storyVideo.value) {
                    return;
                }

                playbackController?.destroy();
                playbackController = createAdaptiveVideoPlaybackController(storyVideo.value, {
                    onFatalError: () => {
                        isLoading.value = false;
                        hasError.value = true;
                    }
                });
                playbackController.attach(
                    buildAdaptiveVideoSource({ ...mediaItem.value, source_url: hlsUrl.value }),
                    getDirectPlaybackFallback(mediaItem.value)
                );
            };

            const muteVideo = () => {
                storyVideo.value.muted = true;
            }

            const unmuteVideo = () => {
                if(hasAttachedMusic()) {
                    storyVideo.value.muted = true;
                    return;
                }

                storyVideo.value.muted = false;
            }

            const hasAttachedMusic = () => {
                return frameHasStoryMusic(frameData.value);
            }

            const pauseToggle = () => {
                if(playerState.isPaused) {
                    storyVideo.value.pause();
                }
                else{
                    playVideo(storyVideo.value);
                }

                syncBackdropVideo();
            }

            const playVideo = (videoElement) => {
                const playPromise = videoElement?.play?.();

                if(playPromise?.catch) {
                    playPromise.catch(() => {});
                }
            }

            const syncBackdropVideo = () => {
                const foregroundVideo = storyVideo.value;
                const backdropVideo = storyBackdropVideo.value;

                if(! foregroundVideo || ! backdropVideo) {
                    return;
                }

                try {
                    if(backdropVideo.readyState > 0 && Number.isFinite(foregroundVideo.currentTime) && Math.abs(backdropVideo.currentTime - foregroundVideo.currentTime) > 0.2) {
                        backdropVideo.currentTime = foregroundVideo.currentTime;
                    }

                    if(foregroundVideo.paused || foregroundVideo.ended) {
                        backdropVideo.pause();
                    }
                    else {
                        playVideo(backdropVideo);
                    }
                } catch (error) {}
            }

            return {
                isLoading: isLoading,
                frameData: frameData,
                storyVideo: storyVideo,
                storyBackdropVideo: storyBackdropVideo,
                mediaSourceUrl: mediaSourceUrl,
                hlsUrl: hlsUrl,
                previewUrl: previewUrl,
                hasError: hasError,
                errorMessage: errorMessage,
                reloadToken: reloadToken,
                foregroundFitClass: computed(() => {
                    return storyMediaObjectFitClass(mediaItem.value, loadedDimensions.value);
                }),
                showBlurBackdrop: computed(() => {
                    return shouldUseStoryBlurBackdrop(mediaItem.value, loadedDimensions.value);
                }),
                handleLoadedMetadata: (event) => {
                    loadedDimensions.value = elementVideoDimensions(event.target);
                    syncBackdropVideo();
                },
                syncBackdropVideo: syncBackdropVideo,
                onLoaded: () => {
                    hasError.value = false;
                    playVideo(storyVideo.value);
                    isLoading.value = false;
                    syncBackdropVideo();
                    colibriEventBus.emit('story:play');
                },
                onMediaError: () => {
                    isLoading.value = false;
                    hasError.value = true;
                },
                retryMedia: () => {
                    hasError.value = false;
                    isLoading.value = true;
                    reloadToken.value += 1;
                    playbackController?.destroy();
                    playbackController = null;
                    nextTick(() => {
                        if (!storyVideo.value || !mediaSourceUrl.value) {
                            isLoading.value = false;
                            hasError.value = true;
                            return;
                        }
                        if(hlsUrl.value) {
                            attachAdaptiveSource();
                        }
                        else {
                            storyVideo.value.load();
                        }
                    });
                }
            }
        },
        components: {
            StoryMediaLoader: StoryMediaLoader
        }
    });
</script>
