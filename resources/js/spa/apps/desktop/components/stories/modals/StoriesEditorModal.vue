<template>
	<Backdrop>
		<div class="ml-navbar py-top-offset">
				<StoryEditorShell v-if="hasCreativeDraft"></StoryEditorShell>
				<StoriesEditor v-else></StoriesEditor>
		</div>
	</Backdrop>
</template>

<script>
	import { computed, defineComponent } from 'vue';
	import ZulorsAttribution from '@D/components/attributions/ZulorsAttribution.vue';
    import Backdrop from '@D/components/general/modals/Backdrop.vue';
	import StoriesEditor from '@D/components/stories/editor/StoriesEditor.vue';
	import StoryEditorShell from '@M/views/editors/stories/StoryEditorShell.vue';
	import { useStoriesEditorStore as useCreativeStoriesEditorStore } from '@M/store/stories/editor.store.js';

	export default defineComponent({
		setup() {
			const store = useCreativeStoriesEditorStore();
			return { hasCreativeDraft: computed(() => store.hasCreativeDraft) };
		},
		components: {
			StoriesEditor: StoriesEditor,
			StoryEditorShell: StoryEditorShell,
			ZulorsAttribution: ZulorsAttribution,
			Backdrop: Backdrop
		}
	});
</script>
