import test from 'node:test';
import assert from 'node:assert/strict';
import {
	profileHeaderCacheKey,
	profileHeaderSnapshot,
	shouldHydrateCachedProfileSnapshot,
} from '../../resources/js/spa/kernel/services/cache/profile-cache.js';

test('profile header cache keys are scoped to viewer and normalized profile id', () => {
	assert.equal(profileHeaderCacheKey(12, 'some user'), 'zulors.profile.header.v1.viewer-12.profile-some%20user');
	assert.notEqual(profileHeaderCacheKey(12, 'someone'), profileHeaderCacheKey(13, 'someone'));
	assert.equal(profileHeaderCacheKey(null, 'someone'), null);
	assert.equal(profileHeaderCacheKey(12, ''), null);
});

test('cached profile header contains display data but grants no cached permissions', () => {
	const snapshot = profileHeaderSnapshot({
		id: 42,
		name: 'Example',
		avatar_url: '/avatar.webp',
		private_field: 'must not be cached',
		meta: { is_owner: true, permissions: { can_follow: true } },
	});

	assert.equal(snapshot.id, 42);
	assert.equal(snapshot.name, 'Example');
	assert.equal(snapshot.private_field, undefined);
	assert.equal(snapshot.meta.is_owner, false);
	assert.equal(snapshot.meta.permissions.can_follow, false);
});

test('cached profile hydrates empty/route-loading views but not background revalidation', () => {
	assert.equal(shouldHydrateCachedProfileSnapshot({}, false), true);
	assert.equal(shouldHydrateCachedProfileSnapshot({ id: 42 }, true), true);
	assert.equal(shouldHydrateCachedProfileSnapshot({ id: 42 }, false), false);
});
