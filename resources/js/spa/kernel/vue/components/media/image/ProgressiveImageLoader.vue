<template>
    <div class="relative block size-full min-h-20 bg-bg-pr overflow-hidden">
        <img
            v-if="base64Image && (! isLoaded || hasError)"
            v-bind:src="base64Image"
            v-bind="$attrs"
            class="absolute inset-0 size-full object-cover"
        alt="Image">
        <div v-if="hasError && ! base64Image" class="absolute inset-0 bg-bg-pr" aria-hidden="true"></div>
        <div v-show="isSensitive" class="absolute inset-0">
            <SensitiveContentAlert></SensitiveContentAlert>
        </div>
        <img
            v-if="! hasError"
            ref="imageRef"
            v-bind:src="src"
            v-bind="$attrs"
            v-bind:loading="loading"
            decoding="async"
            v-bind:fetchpriority="fetchPriority"
            class="relative z-10"
        alt="Image">
    </div>
</template>

<script>
    import { defineComponent, ref, onMounted, onUnmounted } from 'vue';
    
    import SensitiveContentAlert from '@D/components/media/SensitiveContentAlert.vue';

    export default defineComponent({
        emits: ['load', 'error'],
        props: {
            base64Image: {
                type: String,
                default: ''
            },
            src: {
                type: String,
                default: ''
            },
            isSensitive: {
                type: Boolean,
                default: false
            },
            loading: {
                type: String,
                default: 'lazy',
                validator: (value) => ['eager', 'lazy'].includes(value)
            },
            fetchPriority: {
                type: String,
                default: 'auto',
                validator: (value) => ['high', 'low', 'auto'].includes(value)
            }
        },
        setup: function(props, context) {
            const isLoaded = ref(false);
            const hasError = ref(false);
            const imageRef = ref(null);

            onMounted(() => {
                if(imageRef.value?.complete) {
                    if(imageRef.value.naturalWidth && imageRef.value.naturalHeight) {
                        isLoaded.value = true;
                        context.emit('load', { target: imageRef.value });
                    }
                    else {
                        hasError.value = true;
                        context.emit('error', { target: imageRef.value });
                    }

                    return;
                }

                imageRef.value.onload = (event) => {
                    isLoaded.value = true;
                    context.emit('load', event);
                }

                imageRef.value.onerror = (event) => {
                    hasError.value = true;
                    context.emit('error', event);
                }
            });

            onUnmounted(() => {
                if (imageRef.value) {
                    imageRef.value.onload = null;
                    imageRef.value.onerror = null;
                }
            });

            return {
                isLoaded: isLoaded,
                hasError: hasError,
                imageRef: imageRef
            };
        },
        components: {
            SensitiveContentAlert: SensitiveContentAlert
        }
    });
</script>
