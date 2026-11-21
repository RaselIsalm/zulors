<template>
	<div v-outside-click="close" v-on:click.stop class="absolute bottom-full left-0 z-[100] mb-2 w-[min(380px,calc(100vw-24px))] max-w-[calc(100vw-24px)]">
		<Transition name="reaction-popover">
			<div v-if="state.showAll" class="overflow-hidden rounded-2xl border border-fill-qt bg-bg-pr shadow-2xl">
				<div class="flex items-center justify-between border-b border-bord-pr px-4 py-3">
					<h5 class="text-par-m font-medium text-lab-pr2">{{ $t('labels.reactions') }}</h5>
					<button type="button" v-on:click.stop="state.showAll = false" class="flex size-8 items-center justify-center rounded-full text-lab-sc hover:bg-fill-qt" aria-label="Back to quick reactions">
						<SvgIcon name="arrow-left"></SvgIcon>
					</button>
				</div>
				<div class="grid max-h-[min(55vh,420px)] grid-cols-8 gap-1 overflow-y-auto p-3">
					<button
						v-for="emoji in reactionsList"
						v-bind:key="emoji.unified"
						v-bind:title="emoji.short_name || emoji.unified"
						v-on:click.stop="addReaction(emoji)"
						type="button"
						class="flex aspect-square min-w-0 items-center justify-center rounded-xl p-1 transition-transform hover:scale-110 active:scale-95"
					>
						<img class="size-full object-contain" v-bind:src="getEmojiUrl(emoji.image)" loading="lazy" alt="Reaction">
					</button>
				</div>
			</div>
			<div v-else class="flex w-max max-w-full items-center gap-0.5 rounded-full border border-fill-qt bg-bg-pr p-1 shadow-2xl">
				<button
					v-for="emoji in quickReactions"
					v-bind:key="emoji.unified"
					v-bind:title="emoji.short_name || emoji.unified"
					v-on:click.stop="addReaction(emoji)"
					type="button"
					class="flex size-8 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110 active:scale-90"
				>
					<img class="size-7 object-contain" v-bind:src="emoji.url ? $asset(emoji.url) : getEmojiUrl(emoji.image)" loading="lazy" alt="Reaction">
				</button>
				<button type="button" v-on:click.stop="state.showAll = true" class="flex size-8 shrink-0 items-center justify-center rounded-full text-lab-sc transition-colors hover:bg-fill-qt" aria-label="More reactions">
					<SvgIcon name="plus"></SvgIcon>
				</button>
			</div>
		</Transition>
	</div>
</template>

<script>
	import { computed, defineComponent, onMounted, ref } from 'vue';
	import { smileysAndEmotionEmojis } from '@/assets/emojis/apple/categories/smileys-and-emotions.js';

	const USAGE_STORAGE_KEY = 'ZULORS_REACTION_USAGE_V1';

	function normalizeReactionId(value) {
		return String(value || '').toLowerCase();
	}

	export default defineComponent({
		emits: ['add', 'close'],
		setup: function(_, context) {
			const state = ref({ showAll: false });
			const reactionsList = ref(smileysAndEmotionEmojis.emojis);
			const usageByReaction = ref({});
			const popularReactions = ref(embedder('assets.emojis.animated') || []);

			onMounted(() => {
				try {
					const savedUsage = JSON.parse(localStorage.getItem(USAGE_STORAGE_KEY) || '{}');
					if(savedUsage && typeof savedUsage === 'object' && !Array.isArray(savedUsage)) {
						usageByReaction.value = savedUsage;
					}
				}
				catch(error) {
					usageByReaction.value = {};
				}
			});

			const quickReactions = computed(() => {
				const quickList = [];
				const seen = new Set();
				const addUnique = (reaction) => {
					const normalizedId = normalizeReactionId(reaction?.unified);
					if(! normalizedId || seen.has(normalizedId)) {
						return;
					}
					seen.add(normalizedId);
					quickList.push(reaction);
				};

				// Keep the site's curated, popular reactions at the front of the bar.
				popularReactions.value.slice(0, 4).forEach(addUnique);

				// Add the two most frequently used reactions from this browser/device.
				Object.entries(usageByReaction.value)
					.sort((left, right) => (Number(right[1]?.count) - Number(left[1]?.count)) || (Number(right[1]?.lastUsed) - Number(left[1]?.lastUsed)))
					.slice(0, 10)
					.forEach(([unifiedId]) => {
						const reaction = reactionsList.value.find((item) => normalizeReactionId(item.unified) === normalizeReactionId(unifiedId))
							|| popularReactions.value.find((item) => normalizeReactionId(item.unified) === normalizeReactionId(unifiedId));
						if(reaction && quickList.length < 6) {
							addUnique(reaction);
						}
					});

				// Fill unused slots with the site's popular defaults.
				popularReactions.value.forEach((reaction) => {
					if(quickList.length < 6) {
						addUnique(reaction);
					}
				});

				return quickList;
			});

			const recordReactionUse = (reaction) => {
				const unifiedId = normalizeReactionId(reaction.unified);
				const previousUsage = usageByReaction.value[unifiedId] || {};
				usageByReaction.value = {
					...usageByReaction.value,
					[unifiedId]: {
						count: Number(previousUsage.count || 0) + 1,
						lastUsed: Date.now()
					}
				};

				try {
					localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(usageByReaction.value));
				}
				catch(error) {
					// Reaction selection still works if browser storage is unavailable.
				}
			};

			return {
				state,
				reactionsList,
				quickReactions,
				getEmojiUrl: (image) => `${embedder('links.assets.emoji')}/${image}`,
				addReaction: (reaction) => {
					recordReactionUse(reaction);
					context.emit('add', reaction.unified);
				},
				close: () => context.emit('close')
			};
		}
	});
</script>

<style scoped>
	.reaction-popover-enter-active,
	.reaction-popover-leave-active {
		transition: opacity 140ms ease, transform 140ms ease;
		transform-origin: bottom left;
	}

	.reaction-popover-enter-from,
	.reaction-popover-leave-to {
		opacity: 0;
		transform: translateY(6px) scale(0.96);
	}
</style>
