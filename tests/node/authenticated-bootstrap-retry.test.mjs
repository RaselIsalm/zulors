import test from 'node:test';
import assert from 'node:assert/strict';

import {
    bootstrapHasAuthenticatedUser,
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
