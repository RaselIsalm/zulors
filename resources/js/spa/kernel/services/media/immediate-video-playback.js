const DIRECT_PROVIDERS = new Set(['r2', 'r2_temp', 'r2_direct']);
const READY_UPLOAD_STATES = new Set(['uploaded', 'verified', 'ready']);

/**
 * A direct R2 upload is already a playable media object. It must not wait for
 * the optional transcode worker before the feed or reels mounts a player.
 * Processing state is still kept for derived HLS/poster work, but playback
 * uses the canonical MP4 immediately and can switch to HLS when available.
 */
export function canPlayVideoImmediately(item = {}) {

	if(! item?.id || item.status === 'failed') {
		return false;
	}

	const hasPlaybackUrl = Boolean(
		item.preview_url
		|| item.source_url
		|| item.playback_url
		|| item.metadata?.playback?.hls
		|| item.metadata?.playback?.dash
	);

	if(! hasPlaybackUrl) {
		return false;
	}

	if(item.playback_ready === true || item.metadata?.playback_state === 'ready' || item.status === 'processed') {
		return true;
	}

	const provider = item.metadata?.provider || item.playback_mode;
	const uploadState = item.metadata?.upload_state || item.metadata?.upload?.state;

	return DIRECT_PROVIDERS.has(provider)
		&& READY_UPLOAD_STATES.has(uploadState);
}

export default canPlayVideoImmediately;
