import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '@vue/compiler-sfc';

const platforms = {
    mobile: 'mobile',
    desktop: 'desktop',
};

for(const platform of Object.values(platforms)) {
    test(`${platform} feed keeps the poster mounted and only creates a player near the viewport`, async () => {
        const publicationPath = `../../resources/js/spa/apps/${platform}/components/timeline/feed/parts/media/PublicationVideo.vue`;
        const playerPath = `../../resources/js/spa/apps/${platform}/components/players/video/VideoPlayer.vue`;
        const publication = parse((await readFile(new URL(publicationPath, import.meta.url))).toString()).descriptor;
        const player = parse((await readFile(new URL(playerPath, import.meta.url))).toString()).descriptor;

        assert.match(publication.template.content, /ref="mediaViewportRef"/);
        assert.match(publication.template.content, /v-bind:loading="isPriority \? 'eager' : 'lazy'"/);
        assert.match(publication.template.content, /v-bind:fetchpriority="isPriority \? 'high' : 'auto'"/);
        assert.match(publication.template.content, /v-bind:thumbnailUrl="posterUrl"/);
        assert.match(publication.script.content, /thumbnail_url \|\| mediaItem\.value\.lqip_base64/);
        assert.match(publication.template.content, /v-if="isNearViewport"/);
        assert.match(publication.script.content, /rootMargin: '500px 0px'/);
        assert.match(player.template.content, /preload="none"/);
        assert.doesNotMatch(player.template.content, /<video[^>]+(?:src|v-bind:src)=/);
        assert.match(player.script.content, /createAdaptiveVideoPlaybackController/);
    });
}

for(const platform of Object.values(platforms)) {
    test(`${platform} marks the first feed video as priority for an immediate poster`, async () => {
        const timelinePath = `../../resources/js/spa/apps/${platform}/components/timeline/feed/TimelinePublication.vue`;
        const timeline = parse((await readFile(new URL(timelinePath, import.meta.url))).toString()).descriptor;

        assert.match(timeline.template.content, /v-bind:isPriority="position === 1"/);
    });
}

test('timeline media prefetch does not create video elements or request video sources', async () => {
    const source = (await readFile(new URL('../../resources/js/spa/kernel/services/media-prefetch/index.js', import.meta.url))).toString();

    assert.doesNotMatch(source, /createElement\(['"]video['"]\)/);
    assert.doesNotMatch(source, /prefetchVideoSource/);
    assert.match(source, /prefetchImage\(mediaItem\.thumbnail_url\)/);
});
