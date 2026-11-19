import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '@vue/compiler-sfc';

import { calculateVirtualPostWindow } from '../../resources/js/spa/kernel/services/virtual-posts/index.js';

test('small post lists remain fully rendered', () => {
    assert.deepEqual(calculateVirtualPostWindow([120, 240, 360], 120, 600, { threshold: 3 }), {
        start: 0,
        end: 2,
        top: 0,
        bottom: 0,
        total: 720,
    });
});

test('long post lists render a bounded viewport window and preserve measured spacer height', () => {
    const heights = Array.from({ length: 100 }, (_, index) => index % 2 === 0 ? 100 : 200);
    const window = calculateVirtualPostWindow(heights, 5000, 600, { threshold: 20, overscan: 2 });
    const renderedHeight = heights.slice(window.start, window.end + 1).reduce((total, height) => total + height, 0);

    assert.ok(window.start > 0);
    assert.ok(window.end < heights.length - 1);
    assert.ok(window.end - window.start + 1 <= 10);
    assert.equal(window.top + renderedHeight + window.bottom, heights.reduce((total, height) => total + height, 0));
});

test('virtual post window clamps scroll positions and retains the final posts near the list end', () => {
    const window = calculateVirtualPostWindow(Array(50).fill(100), 100000, 500, { threshold: 10, overscan: 2 });

    assert.equal(window.end, 49);
    assert.ok(window.start >= 40);
    assert.equal(window.bottom, 0);
});

for (const platform of ['mobile', 'desktop']) {
    for (const view of ['home/HomeIndex.vue', 'profile/parts/ProfileTimeline.vue']) {
        test(`${platform} ${view} uses the measured post window`, async () => {
            const path = `../../resources/js/spa/apps/${platform}/views/${view}`;
            const component = parse((await readFile(new URL(path, import.meta.url), 'utf8'))).descriptor;

            assert.match(component.template.content, /<VirtualizedPostList/);
            assert.match(component.script.content, /VirtualizedPostList from ['"]@\/kernel\/vue\/components\/lists\/VirtualizedPostList\.vue['"]/);
        });
    }
}
