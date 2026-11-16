<template>
	<div class="size-full relative bg-black">
		<img v-if="lqipBase64 && ! previewFailed" class="size-full object-cover" v-bind:src="lqipBase64" v-on:error="previewFailed = true" alt="" aria-hidden="true">
		<div v-else class="absolute inset-0 bg-fill-pr" aria-hidden="true"></div>
		<div v-if="showSpinner" class="shadow-xs absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-9 bg-white/50 backdrop-blur-2xl rounded-full inline-flex-center justify-center z-10">
			<PrimarySpinAnimation></PrimarySpinAnimation>
		</div>
	</div>
</template>

<script>
    import PrimarySpinAnimation from '@D/components/general/animations/PrimarySpinAnimation.vue';
	import { defineComponent, ref, watch } from 'vue';
    
    export default defineComponent({
		props: {
			lqipBase64: {
				type: String,
				default: ''
			},
			showSpinner: { type: Boolean, default: true }
		},
		setup: function(props) {
			const previewFailed = ref(false);

			watch(() => props.lqipBase64, () => {
				previewFailed.value = false;
			});

			return { previewFailed: previewFailed };
		},
        components: {
            PrimarySpinAnimation: PrimarySpinAnimation
        }
    });
</script>
