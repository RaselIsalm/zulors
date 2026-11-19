<template>
	<div ref="listElement" v-bind="$attrs">
		<div aria-hidden="true" v-bind:style="{ height: `${windowRange.top}px` }"></div>
		<div
			v-for="entry in visibleItems"
			v-bind:key="entry.key"
			v-bind:ref="(element) => setItemElement(entry.key, element)"
		class="virtualized-post-list-item">
			<slot v-bind:item="entry.item" v-bind:index="entry.index"></slot>
		</div>
		<div aria-hidden="true" v-bind:style="{ height: `${windowRange.bottom}px` }"></div>
	</div>
</template>

<script>
	import { computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
	import { calculateVirtualPostWindow } from '@/kernel/services/virtual-posts/index.js';

	export default defineComponent({
		inheritAttrs: false,
		props: {
			items: {
				type: Array,
				default: () => []
			},
			getKey: {
				type: Function,
				default: (item, index) => item?.hash_id || item?.id || index
			},
			estimatedItemHeight: {
				type: Number,
				default: 680
			},
			threshold: {
				type: Number,
				default: 30
			},
			overscan: {
				type: Number,
				default: 3
			}
		},
		setup(props) {
			const listElement = ref(null);
			const initialCount = props.items.length;
			const initialVisibleCount = typeof window !== 'undefined'
				? Math.ceil(window.innerHeight / Math.max(1, props.estimatedItemHeight)) + props.overscan * 2 + 1
				: 9;
			const initialEnd = initialCount <= props.threshold
				? initialCount - 1
				: Math.min(initialCount - 1, initialVisibleCount - 1);
			const initialEstimate = Math.max(1, Number(props.estimatedItemHeight) || 680);
			const initialVirtualized = initialCount > props.threshold;
			const windowRange = ref({
				start: 0,
				end: initialEnd,
				top: 0,
				bottom: initialVirtualized ? Math.max(0, (initialCount - initialEnd - 1) * initialEstimate) : 0,
				total: initialCount * initialEstimate
			});
			const heightByKey = new Map();
			const elementByKey = new Map();
			const keyByElement = new WeakMap();
			const heightVersion = ref(0);
			let resizeObserver = null;
			let scrollFrame = 0;

			const rows = computed(() => props.items.map((item, index) => ({
				item,
				index,
				key: String(props.getKey(item, index))
			})));

			const averageItemHeight = computed(() => {
				heightVersion.value;
				const heights = Array.from(heightByKey.values()).filter((height) => height > 0);

				if(! heights.length) {
					return Math.max(1, Number(props.estimatedItemHeight) || 680);
				}

				const recentHeights = heights.slice(-30);

				return recentHeights.reduce((total, height) => total + height, 0) / recentHeights.length;
			});

			const visibleItems = computed(() => rows.value.slice(windowRange.value.start, windowRange.value.end + 1));

			const measure = (element, key) => {
				if(! element?.getBoundingClientRect) {
					return;
				}

				const height = Math.max(1, Math.round(element.getBoundingClientRect().height));

				if(heightByKey.get(key) !== height) {
					heightByKey.set(key, height);
					heightVersion.value++;
				}
			};

			const setItemElement = (key, element) => {
				const previousElement = elementByKey.get(key);

				if(! element) {
					if(previousElement) {
						resizeObserver?.unobserve(previousElement);
						elementByKey.delete(key);
					}

					return;
				}

				const node = element.$el || element;

				if(previousElement && previousElement !== node) {
					resizeObserver?.unobserve(previousElement);
				}

				elementByKey.set(key, node);
				keyByElement.set(node, key);
				resizeObserver?.observe(node);
				measure(node, key);
			};

			const updateWindow = () => {
				if(! listElement.value || typeof window === 'undefined') {
					return;
				}

				const rowsNow = rows.value;
				const estimatedHeight = averageItemHeight.value;
				const heights = rowsNow.map((row) => heightByKey.get(row.key) || estimatedHeight);
				const listTop = listElement.value.getBoundingClientRect().top + window.scrollY;
				const range = calculateVirtualPostWindow(
					heights,
					Math.max(0, window.scrollY - listTop),
					window.innerHeight,
					{ threshold: props.threshold, overscan: props.overscan }
				);

				windowRange.value = range;
			};

			const scheduleWindowUpdate = () => {
				if(scrollFrame || typeof window === 'undefined') {
					return;
				}

				const update = () => {
					scrollFrame = 0;
					updateWindow();
				};

				scrollFrame = typeof window.requestAnimationFrame === 'function'
					? window.requestAnimationFrame(update)
					: window.setTimeout(update, 16);
			};

			watch(() => props.items.map((item, index) => String(props.getKey(item, index))).join('|'), () => {
				const currentKeys = new Set(rows.value.map((row) => row.key));

				heightByKey.forEach((_, key) => {
					if(! currentKeys.has(key)) {
						heightByKey.delete(key);
						heightVersion.value++;
					}
				});

				nextTick(scheduleWindowUpdate);
			}, { flush: 'post' });

			watch(heightVersion, () => nextTick(scheduleWindowUpdate));

			onMounted(() => {
				if(typeof ResizeObserver !== 'undefined') {
					resizeObserver = new ResizeObserver((entries) => {
						entries.forEach((entry) => {
							const key = keyByElement.get(entry.target);
							const height = Math.max(1, Math.round(entry.contentRect.height));

							if(key !== undefined && heightByKey.get(key) !== height) {
								heightByKey.set(key, height);
								heightVersion.value++;
							}
						});
					});

					elementByKey.forEach((element) => resizeObserver.observe(element));
				}

				window.addEventListener('scroll', scheduleWindowUpdate, { passive: true });
				window.addEventListener('resize', scheduleWindowUpdate, { passive: true });
				scheduleWindowUpdate();
			});

			onUnmounted(() => {
				if(typeof window !== 'undefined') {
					window.removeEventListener('scroll', scheduleWindowUpdate);
					window.removeEventListener('resize', scheduleWindowUpdate);
					if(scrollFrame && typeof window.cancelAnimationFrame === 'function') {
						window.cancelAnimationFrame(scrollFrame);
					}
					else if(scrollFrame) {
						window.clearTimeout(scrollFrame);
					}
				}

				resizeObserver?.disconnect();
				resizeObserver = null;
			});

			return {
				listElement,
				visibleItems,
				windowRange,
				setItemElement
			};
		}
	});
</script>
