<template>
	<div class="story-preview fixed inset-0 z-50 bg-black text-white">
		<div class="absolute inset-x-0 top-0 z-30 flex items-center justify-between px-3 pb-5 from-black/75 to-transparent bg-gradient-to-b" style="padding-top: calc(var(--mobile-safe-top, 0px) + 0.75rem);">
			<button
				type="button"
				class="inline-flex size-11 items-center justify-center rounded-xl bg-black/35 text-white backdrop-blur-md"
				aria-label="Close story preview"
				v-on:click="leavePreview"
			>
				<SvgIcon name="chevron-left" type="line" classes="size-5"></SvgIcon>
			</button>
			<h1 class="min-w-0 truncate px-3 text-title-3 font-semibold">New story</h1>
			<div class="size-11"></div>
		</div>

		<div v-if="media" class="absolute inset-0 flex items-center justify-center overflow-hidden">
			<video
				v-if="isVideo"
				v-bind:src="media.preview_url || media.source_url"
				class="size-full object-contain"
				autoplay
				loop
				muted
				playsinline
				webkit-playsinline
				preload="metadata"
			></video>
			<img
				v-else
				v-bind:src="media.preview_url || media.source_url"
				class="size-full object-contain"
				alt="Story preview"
			/>
		</div>

		<div class="absolute inset-x-0 bottom-0 z-30 px-4 pt-20 from-black/85 via-black/45 to-transparent bg-gradient-to-t" style="padding-bottom: calc(var(--mobile-safe-bottom, 0px) + 1rem);">
			<div v-if="isPublishing || isUploading" class="mb-3 rounded-2xl border border-white/15 bg-black/45 px-4 py-3 text-center text-par-s text-white/85 backdrop-blur-md">
				{{ publishLabel }}
				<span v-if="uploadProgress"> {{ uploadProgress }}%</span>
			</div>

			<div class="grid grid-cols-2 gap-3">
				<button
					type="button"
					class="min-h-12 rounded-2xl border border-white/25 bg-white/10 px-4 text-par-m font-semibold text-white backdrop-blur-md disabled:cursor-wait disabled:opacity-50"
					v-bind:disabled="! media || isPublishing || isUploading"
					v-on:click="openEditor"
				>
					Edit
				</button>
				<button
					type="button"
					class="min-h-12 rounded-2xl bg-white px-4 text-par-m font-semibold text-black disabled:cursor-wait disabled:opacity-50"
					v-bind:disabled="! media || isPublishing || isUploading"
					v-on:click="publish"
				>
					Publish story
				</button>
			</div>
		</div>

		<div v-if="showVideoFallback" class="absolute inset-0 z-40 flex items-end bg-black/55 px-4" style="padding-bottom: calc(var(--mobile-safe-bottom, 0px) + 6rem);">
			<div class="w-full rounded-3xl border border-white/15 bg-[#171717] p-5 shadow-2xl">
				<p class="text-par-l font-semibold">Video editing is unavailable here</p>
				<p class="mt-2 text-par-s leading-5 text-white/70">Open this story on a supported desktop browser to edit the video, or publish the original video now.</p>
				<div class="mt-5 grid grid-cols-2 gap-3">
					<button type="button" class="min-h-11 rounded-xl border border-white/20 px-3 text-par-s font-semibold" v-on:click="showVideoFallback = false">Cancel</button>
					<button type="button" class="min-h-11 rounded-xl bg-white px-3 text-par-s font-semibold text-black" v-on:click="showVideoFallback = false">Use original</button>
				</div>
			</div>
		</div>
	</div>
</template>

<script>
	import { computed, defineComponent, ref } from 'vue';
	import { useRouter } from 'vue-router';
	import { useStoriesEditorStore } from '@M/store/stories/editor.store.js';

	const mobileBrowserPattern = /Android|iPhone|iPad|iPod/i;

	export default defineComponent({
		setup: function() {
			const router = useRouter();
			const storiesEditorStore = useStoriesEditorStore();
			const showVideoFallback = ref(false);

			const media = computed(() => storiesEditorStore.previewMedia);
			const isVideo = computed(() => media.value?.type === 'video');
			const isUploading = computed(() => storiesEditorStore.isUploading);
			const isPublishing = computed(() => storiesEditorStore.isPublishing);
			const uploadProgress = computed(() => storiesEditorStore.uploadProgress);
			const publishLabel = computed(() => isPublishing.value ? 'Publishing story' : 'Uploading media');

			const openEditor = () => {
				if(! storiesEditorStore.creativeEditorEnabled) {
					toastError('Editing is currently unavailable. You can still publish your original photo or video.');
					return;
				}
				if(isVideo.value && mobileBrowserPattern.test(navigator.userAgent || '')) {
					showVideoFallback.value = true;
					return;
				}

				if(! storiesEditorStore.openCreativeEditor()) {
					toastError('Story media is no longer available.');
				}
			};

			const publish = async () => {
				try {
					const result = await storiesEditorStore.publishStory({
						musicBaked: storiesEditorStore.creativeMusicBaked
					});

					toastSuccess(result?.queued ? 'Story upload started' : __t('toast.story.story_published'));
					storiesEditorStore.resetEditor();
					router.push({ name: 'home_index' });
				}
				catch(error) {
					toastError(error?.message || 'Story could not be published.');
				}
			};

			const leavePreview = () => {
				if(isPublishing.value || isUploading.value) return;

				storiesEditorStore.resetEditor();
				router.push({ name: 'home_index' });
			};

			return {
				media,
				isVideo,
				isUploading,
				isPublishing,
				uploadProgress,
				publishLabel,
				showVideoFallback,
				openEditor,
				publish,
				leavePreview,
			};
		}
	});
</script>
