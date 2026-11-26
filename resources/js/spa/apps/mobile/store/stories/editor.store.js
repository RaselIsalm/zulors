import { defineStore } from 'pinia';
import { publicationManager } from '@/kernel/services/media/publications/index.js';
import { isPublicationMedia, publicationMediaType, selectPublicationMedia, releasePublicationSelection } from '@/kernel/services/media/publications/selection.js';
import { directVideoUpload } from '@/kernel/services/media/r2-direct-video-upload.js';
import { colibriAPI } from '@/kernel/services/api-client/native/index.js';
import { useStoriesStore } from '@M/store/stories/stories.store.js';
import { appendStoryMusicUploadMetadata, storyMusicPublishPayload, storyMusicUploadOptions } from '@/kernel/services/media/story-music-upload.js';
import { clearStoryEditorDraft, loadStoryEditorDraft, saveStoryEditorDraft } from '@/kernel/services/media/story-editor-draft.js';

const STORY_EDITOR_PROVIDER = String(import.meta.env.VITE_STORY_EDITOR_PROVIDER || 'legacy').toLowerCase();
const STORY_EDITOR_LEGACY_FALLBACK = String(import.meta.env.VITE_STORY_EDITOR_LEGACY_FALLBACK ?? 'true') !== 'false';
const IMGLY_CESDK_LICENSE = String(import.meta.env.VITE_IMGLY_CESDK_LICENSE_KEY || import.meta.env.VITE_IMGLY_LICENSE_KEY || '').trim();

function isLocalEditableMedia(file) {
	const mime = file?.type || file?.mime || '';

	return file instanceof Blob && ! file.native_file_id && (mime.startsWith('image/') || mime.startsWith('video/')) && ! /\.gif$/i.test(file?.name || '');
}

function storyClipOptionsFromCandidate(clipCandidate = null) {
	if(! clipCandidate) {
		return {};
	}

	return {
		clip_start_seconds: Math.max(0, Math.floor(Number(clipCandidate.clipStartSeconds || 0))),
		clip_duration_seconds: Math.max(1, Math.min(60, Math.ceil(Number(clipCandidate.clipDurationSeconds || 60))))
	};
}

const useStoriesEditorStore = defineStore('mobile_stories_editor_store', {
	state: function() {
		return {
			discardUploadedMedia: false,
			isUploading: false,
			uploadProgress: 0,
			videoClipCandidate: null,
			storyMedia: null,
			storyImageTransform: { scale: 1, translateX: 0, translateY: 0, rotation: 0 },
			publicationSelection: null,
			publicationOptions: {},
			storyMediaObjectUrl: null,
			creativeDraft: null,
			creativeEditorOpen: false,
			creativeEditorDirty: false,
			creativeEditorInitialMusicTrack: null,
			creativeEditorInitialMusicBaked: false,
			creativeMusicBaked: false,
			isPublishing: false,
			selectedMusicTrack: null,
			storyData: {
				content: ''
			}
		}
	},
	getters: {
		isFormValid: (state) => {
			return Boolean(state.storyMedia || state.creativeDraft?.file) && !state.isUploading && !state.isPublishing;
		},
		previewMedia: (state) => {
			if(state.storyMedia) return state.storyMedia;

			if(state.creativeDraft?.file && state.creativeDraft?.objectUrl) {
				return {
					type: state.creativeDraft.type,
					source_url: state.creativeDraft.objectUrl,
					preview_url: state.creativeDraft.objectUrl,
					mime: state.creativeDraft.mime,
					name: state.creativeDraft.name,
					is_local_preview: true,
				};
			}

			return null;
		},
		hasCreativeDraft: (state) => {
			return Boolean(state.creativeDraft?.file && state.creativeDraft?.objectUrl);
		},
		creativeEditorEnabled: () => {
			return STORY_EDITOR_PROVIDER === 'imgly' && Boolean(IMGLY_CESDK_LICENSE);
		},
		imglyLicenseKey: () => {
			return IMGLY_CESDK_LICENSE;
		},
		legacyEditorFallbackEnabled: () => {
			return STORY_EDITOR_LEGACY_FALLBACK;
		}
	},
	actions: {
		releaseMediaPreview: function() {
			if(this.storyMediaObjectUrl) URL.revokeObjectURL(this.storyMediaObjectUrl);
			this.storyMediaObjectUrl = null;
		},
		releaseCreativeDraft: function() {
			new Set([
				this.creativeDraft?.objectUrl,
				this.creativeDraft?.sourceObjectUrl,
			]).forEach((url) => {
				if(url) URL.revokeObjectURL(url);
			});

			this.creativeDraft = null;
		},
		persistCreativeDraft: function() {
			if(! this.creativeDraft?.file) return;

			saveStoryEditorDraft({
				...this.creativeDraft,
				selectedMusicTrack: this.selectedMusicTrack ? { ...this.selectedMusicTrack } : null,
				musicBaked: this.creativeMusicBaked,
			});
		},
		restoreCreativeDraft: async function() {
			if(this.creativeDraft || this.storyMedia) return false;

			const draft = await loadStoryEditorDraft();
			if(! draft?.blob) return false;

			const file = new File([draft.blob], draft.name || 'story-media', {
				type: draft.mime || draft.blob.type || 'application/octet-stream',
				lastModified: Date.now(),
			});
			const objectUrl = URL.createObjectURL(file);

			this.creativeDraft = {
				file,
				objectUrl,
				sourceObjectUrl: objectUrl,
				name: draft.name || file.name,
				mime: draft.mime || file.type,
				type: draft.type || (file.type?.startsWith('video/') ? 'video' : 'image'),
				clipCandidate: draft.clipCandidate || null,
				legacyUploadOptions: draft.legacyUploadOptions || {},
				exportMetadata: draft.exportMetadata || {},
				edited: Boolean(draft.edited),
				createdAt: draft.updatedAt || Date.now(),
			};
			this.selectedMusicTrack = draft.selectedMusicTrack || null;
			this.creativeMusicBaked = Boolean(draft.musicBaked);
			this.creativeEditorOpen = false;

			return true;
		},
		resetEditor: function() {
			this.publicationSelection = null;
			this.publicationOptions = {};
			this.releaseMediaPreview();
			this.releaseCreativeDraft();
			this.creativeEditorOpen = false;
			this.creativeEditorDirty = false;
			this.creativeEditorInitialMusicTrack = null;
			this.creativeEditorInitialMusicBaked = false;
			this.clearVideoClipCandidate();
			this.creativeMusicBaked = false;
			this.discardUploadedMedia = false;
			this.isUploading = false;
			this.isPublishing = false;
			this.uploadProgress = 0;
			this.storyMedia = null;
			this.storyImageTransform = { scale: 1, translateX: 0, translateY: 0, rotation: 0 };
			this.selectedMusicTrack = null;
			this.storyData = {
				content: ''
			}
			clearStoryEditorDraft();
		},
		setSelectedMusicTrack: function(trackData) {
			this.selectedMusicTrack = trackData;
			if(this.creativeEditorOpen) this.creativeEditorDirty = true;
			this.persistCreativeDraft();
		},
		clearSelectedMusicTrack: function() {
			this.selectedMusicTrack = null;
			if(this.creativeEditorOpen) this.creativeEditorDirty = true;
			this.persistCreativeDraft();
		},
		setVideoClipCandidate: function(clipCandidate) {
			this.clearVideoClipCandidate();
			this.videoClipCandidate = clipCandidate;
		},
		clearVideoClipCandidate: function() {
			if(this.videoClipCandidate?.objectUrl) {
				URL.revokeObjectURL(this.videoClipCandidate.objectUrl);
			}

			this.videoClipCandidate = null;
		},
		cancelPendingUpload: function() {
			if(this.isUploading) {
				this.discardUploadedMedia = true;
				return;
			}

			this.resetEditor();
		},
		canUseCreativeEditorForFile: function(file) {
			return this.creativeEditorEnabled && isLocalEditableMedia(file);
		},
		startCreativeDraft: function(file, clipCandidate = null) {
			if(! isLocalEditableMedia(file)) {
				return false;
			}

			this.publicationSelection = null;
			this.publicationOptions = {};
			this.releaseMediaPreview();
			this.releaseCreativeDraft();
			this.clearVideoClipCandidate();
			this.discardUploadedMedia = false;
			this.isUploading = false;
			this.uploadProgress = 0;
			this.storyMedia = null;
			this.creativeEditorOpen = false;
			this.creativeEditorDirty = false;
			this.creativeEditorInitialMusicTrack = null;
			this.creativeEditorInitialMusicBaked = false;
			this.creativeMusicBaked = false;
			this.selectedMusicTrack = null;
			this.storyData = {
				content: ''
			};

			this.creativeDraft = {
				file: file,
				objectUrl: URL.createObjectURL(file),
				name: file.name || (file.type?.startsWith('video/') ? 'story-video.mp4' : 'story-image.jpg'),
				mime: file.type || 'application/octet-stream',
				type: file.type?.startsWith('video/') ? 'video' : 'image',
				clipCandidate: clipCandidate,
				legacyUploadOptions: storyClipOptionsFromCandidate(clipCandidate),
				createdAt: Date.now()
			};
			this.creativeDraft.sourceObjectUrl = this.creativeDraft.objectUrl;
			this.persistCreativeDraft();

			return true;
		},
		openCreativeEditor: function() {
			if(! this.creativeEditorEnabled || ! this.hasCreativeDraft) return false;

			this.creativeEditorInitialMusicTrack = this.selectedMusicTrack;
			this.creativeEditorInitialMusicBaked = this.creativeMusicBaked;
			this.creativeEditorDirty = false;
			this.creativeEditorOpen = true;

			return true;
		},
		closeCreativeEditor: function() {
			this.creativeEditorOpen = false;
			this.creativeEditorDirty = false;
			this.creativeEditorInitialMusicTrack = null;
			this.creativeEditorInitialMusicBaked = false;
		},
		discardCreativeChanges: function() {
			this.selectedMusicTrack = this.creativeEditorInitialMusicTrack || null;
			this.creativeMusicBaked = this.creativeEditorInitialMusicBaked;
			this.closeCreativeEditor();
			this.persistCreativeDraft();
		},
		applyCreativeExport: function(mediaFile, exportMetadata = {}) {
			if(! this.creativeDraft?.file || ! mediaFile) {
				throw new Error('The story draft is no longer available.');
			}

			const previousObjectUrl = this.creativeDraft.objectUrl;
			const objectUrl = URL.createObjectURL(mediaFile);

			this.creativeDraft.file = mediaFile;
			this.creativeDraft.objectUrl = objectUrl;
			this.creativeDraft.mime = mediaFile.type || this.creativeDraft.mime;
			this.creativeDraft.name = mediaFile.name || this.creativeDraft.name;
			this.creativeDraft.exportMetadata = { ...exportMetadata };
			this.creativeDraft.edited = true;

			if(previousObjectUrl && previousObjectUrl !== this.creativeDraft.sourceObjectUrl) {
				URL.revokeObjectURL(previousObjectUrl);
			}

			this.closeCreativeEditor();
			this.persistCreativeDraft();
		},
		uploadCreativeDraftWithLegacy: async function() {
			const draft = this.creativeDraft;

			if(! draft?.file) {
				throw new Error('Select a photo or video.');
			}

			this.releaseCreativeDraft();

			return this.uploadMedia(draft.file, draft.legacyUploadOptions || {});
		},
		uploadCreativeExport: async function(mediaFile, exportMetadata = {}) {
			const uploadOptions = {
				...exportMetadata,
				skip_publication_manager: true
			};

			return this.uploadMedia(mediaFile, uploadOptions);
		},
		setCreativeMusicBaked: function(value) {
			this.creativeMusicBaked = Boolean(value);
			this.persistCreativeDraft();
		},
		publishStory: async function(options = {}) {
			if(this.isPublishing) return;

			this.isPublishing = true;

			try {
				if(this.creativeDraft?.file && ! this.storyMedia) {
					await this.uploadMedia(this.creativeDraft.file, {
						...(this.creativeDraft.legacyUploadOptions || {}),
						...(this.creativeDraft.exportMetadata || {}),
						skip_publication_manager: true,
					});
				}

				const selectedTrackForPublish = this.creativeDraft?.file && ! this.creativeDraft.edited
					? null
					: this.selectedMusicTrack;
				const musicPayload = storyMusicPublishPayload(selectedTrackForPublish, {
					bakedIntoMedia: (! this.creativeDraft || this.creativeDraft.edited)
						&& Boolean(options.musicBaked || this.creativeMusicBaked)
				});

				if (this.publicationSelection) {
					await publicationManager.enqueue({ kind: 'story', content: '', privacy: this.storyData.privacy || 'all', selected_user_ids: this.storyData.selected_user_ids || [], ...this.publicationOptions, ...musicPayload }, [this.publicationSelection]);
					return { queued: true };
				}

				const storiesStore = useStoriesStore();
				if (this.storyMedia) {
					await colibriAPI().storyEditor().with({
						content: '',
						story_image_transform: this.storyMedia.type === 'image' ? this.storyImageTransform : undefined,
						...musicPayload
					}).sendTo('create').then((response) => {
						if(response.data.data) {
							storiesStore.prependFeedItem(response.data.data);
						}
					}).catch((error) => {
						if(error.response) {
							throw new Error(error.response.data.message);
						}
						throw error;
					});
				}
			}
			finally {
				this.isPublishing = false;
			}
		},
		uploadMedia: async function(mediaFile, options = {}) {
			const { skip_publication_manager: skipPublicationManager, ...mediaOptions } = options;
			const uploadOptions = storyMusicUploadOptions(mediaFile, mediaOptions);

			if (! skipPublicationManager && isPublicationMedia(mediaFile)) {
				this.isUploading = true;
				try {
					if (await publicationManager.enabled('story')) {
						const selection = await selectPublicationMedia(mediaFile, publicationManager.account);
						if (this.discardUploadedMedia) {
							releasePublicationSelection(selection);
							this.discardUploadedMedia = false;
							return;
						}
						this.releaseMediaPreview();
						this.publicationSelection = selection;
						this.publicationOptions = uploadOptions;
						this.storyMediaObjectUrl = selection.preview_url;
						this.storyMedia = selection;
						return;
					}
				} finally { this.isUploading = false; }
			}
			if(publicationMediaType(mediaFile) === 'video' || mediaFile?.type?.startsWith('video/')) {
				this.isUploading = true;
				let uploadCreated = false;
				try {
					const media = await directVideoUpload({
						file: mediaFile,
						options: uploadOptions,
						includePoster: true,
						request: (action, payload) => colibriAPI().storyEditor().with(payload).sendTo('media/video/direct/' + action),
						onProgress: progress => { this.uploadProgress = progress; },
						onCreated: upload => {
							uploadCreated = true;
							this.releaseMediaPreview();
							this.storyMediaObjectUrl = URL.createObjectURL(mediaFile);
							this.storyMedia = {
								...upload,
								source_url: upload.source_url || upload.preview_url || this.storyMediaObjectUrl,
								preview_url: upload.preview_url || upload.source_url || this.storyMediaObjectUrl,
								is_local_preview: ! (upload.source_url || upload.preview_url),
							};
						},
					});
					if(media) {
						this.releaseMediaPreview();
						this.storyMediaObjectUrl = URL.createObjectURL(mediaFile);
						this.storyMedia = {
							...media,
							source_url: media.source_url || media.preview_url || this.storyMediaObjectUrl,
							preview_url: media.preview_url || media.source_url || this.storyMediaObjectUrl,
							is_local_preview: ! (media.source_url || media.preview_url),
						};
						if(this.discardUploadedMedia) {
							this.discardUploadedMedia = false;
							await this.deleteMedia();
						}
						return;
					}
					throw new Error('Direct video upload is unavailable. Please try again when storage upload is available.');
				}
				catch(error) {
					if(uploadCreated) await this.deleteMedia().catch(() => {});
					throw error;
				}
				finally {
					this.isUploading = false;
					this.uploadProgress = 0;
				}
			}
			if(mediaFile.type.startsWith('image/')) {
				this.isUploading = true;

				try {
					const formData = new FormData();
					formData.append('media_file', mediaFile, mediaFile.name || `zulors-story-${Date.now()}.jpg`);
					appendStoryMusicUploadMetadata(formData, uploadOptions);

					const response = await colibriAPI().storyEditor()
						.with(formData)
						.withHeaders({ 'Content-Type': 'multipart/form-data' })
						.uploadProgress((event) => {
							const total = Number(event?.total || mediaFile.size || 1);
							this.uploadProgress = Math.min(100, Math.round((Number(event?.loaded || 0) / total) * 100));
						})
						.sendTo('media/upload');

					const media = response.data?.data;
					if(! media) throw new Error('The story image upload returned no media.');

					this.releaseMediaPreview();
					this.storyMediaObjectUrl = URL.createObjectURL(mediaFile);
					this.storyMedia = {
						...media,
						source_url: media.source_url || this.storyMediaObjectUrl,
						preview_url: media.preview_url || media.source_url || this.storyMediaObjectUrl,
						is_local_preview: ! (media.source_url || media.preview_url),
					};

					return media;
				}
				catch(error) {
					if(error.response) throw new Error(error.response.data.message || 'Story image upload failed.');
					throw error;
				}
				finally {
					this.isUploading = false;
					this.uploadProgress = 0;
				}
			}
			throw new Error('This story attachment type is unsupported. Choose a photo or video for direct R2 upload.');
		},
		deleteMedia: async function() {
			if (this.publicationSelection) {
				this.releaseMediaPreview();
				this.publicationSelection = null;
				this.publicationOptions = {};
				this.storyMedia = null;
				this.clearSelectedMusicTrack();
				return;
			}
			this.releaseMediaPreview();
			this.storyMedia = null;
			this.clearSelectedMusicTrack();

			await colibriAPI().storyEditor().delete('media/delete').catch((error) => {;
				if(error.response) {
					throw new Error(error.response.data.message);
				}
			});
		}
	}
});

export { useStoriesEditorStore };
