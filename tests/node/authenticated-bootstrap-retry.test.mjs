import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    bootstrapHasAuthenticatedUser,
    isExpiredSessionStatus,
    preserveServerAuthenticatedUser,
    shouldRetryAuthenticatedBootstrap
} from '../../resources/js/spa/kernel/services/authenticated-bootstrap/index.js';

test('an authenticated server page retries a bootstrap response that briefly loses its session', () => {
    assert.equal(shouldRetryAuthenticatedBootstrap({
        serverAuthenticated: true,
        bootstrapData: { auth: { status: false, user: null } },
        attemptIndex: 0,
        attemptCount: 3
    }), true);
});

test('an authenticated bootstrap response is accepted without a retry', () => {
    const bootstrapData = { auth: { status: true, user: { id: 42 } } };

    assert.equal(bootstrapHasAuthenticatedUser(bootstrapData), true);
    assert.equal(shouldRetryAuthenticatedBootstrap({
        serverAuthenticated: true,
        bootstrapData,
        attemptIndex: 0,
        attemptCount: 3
    }), false);
});

test('guest pages and the final bootstrap attempt do not retry', () => {
    const guestBootstrap = { auth: { status: false, user: null } };

    assert.equal(shouldRetryAuthenticatedBootstrap({
        serverAuthenticated: false,
        bootstrapData: guestBootstrap,
        attemptIndex: 0,
        attemptCount: 3
    }), false);
    assert.equal(shouldRetryAuthenticatedBootstrap({
        serverAuthenticated: true,
        bootstrapData: guestBootstrap,
        attemptIndex: 2,
        attemptCount: 3
    }), false);
});

test('an authenticated server page keeps its user when bootstrap returns a guest payload', () => {
    const serverAuthUser = { id: 42, username: 'new_user' };
    const resolvedBootstrap = preserveServerAuthenticatedUser({
        bootstrapData: { auth: { status: false, user: null }, home_feed: null },
        serverAuthenticated: true,
        serverAuthUser,
        serverAuthUserId: 42
    });

    assert.equal(resolvedBootstrap.auth.status, true);
    assert.equal(resolvedBootstrap.auth.user, serverAuthUser);
    assert.equal(resolvedBootstrap.home_feed, null);
});

test('an authenticated page never accepts bootstrap data for a different account', () => {
    const serverAuthUser = { id: 42, username: 'current_user' };
    const resolvedBootstrap = preserveServerAuthenticatedUser({
        bootstrapData: { auth: { status: true, user: { id: 17, username: 'stale_user' } } },
        serverAuthenticated: true,
        serverAuthUser,
        serverAuthUserId: 42
    });

    assert.equal(resolvedBootstrap.auth.user, serverAuthUser);
});

test('a guest page does not restore cached authenticated state', () => {
    const resolvedBootstrap = preserveServerAuthenticatedUser({
        bootstrapData: { auth: { status: false, user: null } },
        serverAuthenticated: false,
        serverAuthUser: { id: 42, username: 'old_user' }
    });

    assert.equal(resolvedBootstrap.auth.user, null);
});

test('only unauthorized and expired-CSRF responses invalidate the app session', () => {
    assert.equal(isExpiredSessionStatus(401), true);
    assert.equal(isExpiredSessionStatus(419), true);
    assert.equal(isExpiredSessionStatus(403), false);
    assert.equal(isExpiredSessionStatus(500), false);
});

for(const platform of ['mobile', 'desktop']) {
    test(`${platform} bootstrap does not clear auth on a forbidden response`, async () => {
        const source = await readFile(new URL(
            `../../resources/js/spa/apps/${platform}/store/app/app.store.js`,
            import.meta.url
        ), 'utf8');

        assert.match(source, /const isSessionError = isExpiredSessionStatus\(statusCode\)/);
        assert.doesNotMatch(source, /\[401,\s*403,\s*419\]\.includes\(statusCode\)/);
    });
}

test('Android WebView flushes cookies after successful password and Google auth handoffs', async () => {
    const source = await readFile(new URL(
        '../../android/LocalAndroidPreview/src/com/zulors/localpreview/MainActivity.java',
        import.meta.url
    ), 'utf8');

    assert.match(source, /isAccountCreationHandoffUrl\(url\) \|\| isAuthenticationEntryUrl\(url\)/);
    assert.match(source, /"\/auth\/login"\.equals\(path\) \|\| "\/auth\/signup"\.equals\(path\)/);
    assert.match(source, /flushCookiesAfterAuthHandoff\s*&&\s*isTrustedWebUrl\(Uri\.parse\(url\)\)\s*&&\s*!isAuthenticationEntryUrl\(url\)/);
    assert.match(source, /CookieManager\.getInstance\(\)\.flush\(\)/);
});
