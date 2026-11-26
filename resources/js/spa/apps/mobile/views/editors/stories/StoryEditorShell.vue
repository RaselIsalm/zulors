<template>
	<div v-if="restoringDraft" class="fixed inset-0 z-50 flex items-center justify-center bg-black text-white">
		<div class="text-center">
			<div class="mx-auto size-9 animate-spin rounded-full border-2 border-white/20 border-t-white"></div>
			<p class="mt-4 text-par-s text-white/75">Preparing story</p>
		</div>
	</div>
	<StoryCreativeEditor
		v-else-if="showCreativeEditor"
		v-on:fallback="activateLegacyFallback"
	></StoryCreativeEditor>
	<StoryPreview v-else-if="showCreativePreview"></StoryPreview>
	<StoriesEditor v-else></StoriesEditor>
</template>

<script>
	import { defineComponent, computed, onMounted, ref } from 'vue';
	import { useStoriesEditorStore } from '@M/store/stories/editor.store.js';

	import StoriesEditor from '@M/views/editors/stories/StoriesEditor.vue';
	import StoryCreativeEditor from '@M/views/editors/stories/StoryCreativeEditor.vue';
	import StoryPreview from '@M/views/editors/stories/StoryPreview.vue';

	export default defineComponent({
		setup: function() {
			const storiesEditorStore = useStoriesEditorStore();
			const legacyFallbackActive = ref(false);
			const restoringDraft = ref(true);

			onMounted(async () => {
				try {
					await storiesEditorStore.restoreCreativeDraft();
				}
				finally {
					restoringDraft.value = false;
				}
			});

			const activateLegacyFallback = async (error) => {
				if(! storiesEditorStore.legacyEditorFallbackEnabled) {
					toastError(error?.message || 'Creative editor is unavailable.');
					return;
				}

				try {
					legacyFallbackActive.value = true;
					toastError('Creative editor is unavailable. Opening the standard story editor.');
					await storiesEditorStore.uploadCreativeDraftWithLegacy();
				} catch (fallbackError) {
					toastError(fallbackError.message);
					storiesEditorStore.resetEditor();
				}
			};

			return {
				restoringDraft: restoringDraft,
				showCreativePreview: computed(() => {
					return ! legacyFallbackActive.value && storiesEditorStore.creativeEditorEnabled && storiesEditorStore.hasCreativeDraft;
				}),
				showCreativeEditor: computed(() => {
					return ! legacyFallbackActive.value
						&& storiesEditorStore.creativeEditorEnabled
						&& storiesEditorStore.hasCreativeDraft
						&& storiesEditorStore.creativeEditorOpen;
				}),
				activateLegacyFallback: activateLegacyFallback
			};
		},
		components: {
			StoriesEditor: StoriesEditor,
			StoryCreativeEditor: StoryCreativeEditor,
			StoryPreview: StoryPreview
		}
	});
</script>
