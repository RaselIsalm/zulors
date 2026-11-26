export function shouldHydrateCachedProfileSnapshot(currentProfile, showLoader) {
	return Boolean(showLoader || ! currentProfile?.id);
}

export function profileHeaderSnapshot(data) {
	const visibleFields = [
		'id', 'name', 'first_name', 'last_name', 'username', 'caption', 'avatar_url',
		'cover_url', 'profile_url', 'bio', 'join_date', 'website', 'verified',
		'publications_count', 'followers_count', 'following_count', 'country',
		'country_name', 'city'
	];
	const snapshot = {};

	for(const field of visibleFields) {
		if(data[field] !== undefined) {
			snapshot[field] = data[field];
		}
	}

	return {
		...snapshot,
		meta: {
			is_owner: false,
			permissions: {
				can_sanction: false,
				can_follow: false,
				can_mention: false,
				can_message: false,
				can_block: false,
				can_report: false,
				can_mute: false
			},
			relationship: {
				follow: { following: false, followed_by: false, requested: false },
				block: { blocking: false, blocked_by: false },
				muting: { muting: false }
			}
		}
	};
}

export function profileHeaderCacheKey(viewerId, username) {
	if(! viewerId || ! username) {
		return null;
	}

	return `zulors.profile.header.v1.viewer-${viewerId}.profile-${encodeURIComponent(username)}`;
}
