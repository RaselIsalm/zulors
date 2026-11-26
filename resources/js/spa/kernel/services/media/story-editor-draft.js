const DB_NAME = 'zulors-story-editor';
const STORE_NAME = 'drafts';
const DRAFT_KEY = 'active';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function openDraftDatabase() {
	if(typeof window === 'undefined' || !window.indexedDB) {
		return Promise.resolve(null);
	}

	return new Promise((resolve, reject) => {
		const request = window.indexedDB.open(DB_NAME, 1);

		request.onupgradeneeded = () => {
			if(! request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('Unable to open the story draft store.'));
	});
}

function runDraftTransaction(mode, callback) {
	return openDraftDatabase().then((database) => {
		if(! database) return null;

		return new Promise((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, mode);
			const store = transaction.objectStore(STORE_NAME);
			let result;

			try {
				result = callback(store);
			}
			catch(error) {
				reject(error);
				return;
			}

			transaction.oncomplete = () => resolve(result && typeof result === 'object' && 'result' in result ? result.result : result);
			transaction.onerror = () => reject(transaction.error || new Error('Story draft storage failed.'));
		});
	});
}

async function saveStoryEditorDraft(draft) {
	if(! draft?.file) return;

	await runDraftTransaction('readwrite', (store) => {
		store.put({
			id: DRAFT_KEY,
			blob: draft.file,
			name: draft.name || draft.file.name || 'story-media',
			mime: draft.mime || draft.file.type || 'application/octet-stream',
			type: draft.type,
			clipCandidate: draft.clipCandidate || null,
			legacyUploadOptions: draft.legacyUploadOptions || {},
			exportMetadata: draft.exportMetadata || {},
			edited: Boolean(draft.edited),
			selectedMusicTrack: draft.selectedMusicTrack || null,
			musicBaked: Boolean(draft.musicBaked),
			updatedAt: Date.now(),
		});
	}).catch(() => {});
}

async function loadStoryEditorDraft() {
	const record = await runDraftTransaction('readonly', (store) => store.get(DRAFT_KEY)).catch(() => null);

	if(! record || ! record.blob || Date.now() - Number(record.updatedAt || 0) > MAX_AGE_MS) {
		if(record) await clearStoryEditorDraft();
		return null;
	}

	return record;
}

async function clearStoryEditorDraft() {
	await runDraftTransaction('readwrite', (store) => store.delete(DRAFT_KEY)).catch(() => {});
}

export { clearStoryEditorDraft, loadStoryEditorDraft, saveStoryEditorDraft };
