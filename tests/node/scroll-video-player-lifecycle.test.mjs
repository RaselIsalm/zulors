import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '@vue/compiler-sfc';

const readVue = async path => parse((await readFile(new URL(path, import.meta.url))).toString()).descriptor;

test('mobile feed keeps its loaded source and frame while a video is off-screen', async () => {
    const player = await readVue('../../resources/js/spa/apps/mobile/components/players/video/VideoPlayer.vue');
    const visibilityWatch = player.script.content.match(/watch\(isIntersecting, \(isVisible\) => \{([\s\S]*?)\n\s*\}\);/)?.[1] || '';

    assert.match(visibilityWatch, /playbackController\.stopLoad\(\)/);
    assert.doesNotMatch(visibilityWatch, /playbackController\.suspend\(/);
    assert.doesNotMatch(visibilityWatch, /playbackAttached\s*=\s*false/);
    assert.doesNotMatch(visibilityWatch, /state\.isLoaded\s*=\s*false/);
    assert.match(visibilityWatch, /playbackController\?\.startLoad\(/);
    assert.doesNotMatch(player.script.content, /if\(state\.isLoaded\)\s*\{\s*return;\s*\}/);
    assert.match(player.script.content, /playbackController\.setSource\(playbackSource\.value, directFallbackSource\.value\);[\s\S]*?state\.isLoaded = false/);
});

test('desktop feed also keeps its loaded source and frame while a video is off-screen', async () => {
    const player = await readVue('../../resources/js/spa/apps/desktop/components/players/video/VideoPlayer.vue');
    const visibilityWatch = player.script.content.match(/watch\(isIntersecting, \(isVisible\) => \{([\s\S]*?)\n\s*\}\);/)?.[1] || '';

    assert.match(visibilityWatch, /playbackController\.stopLoad\(\)/);
    assert.doesNotMatch(visibilityWatch, /playbackController\.suspend\(/);
    assert.match(visibilityWatch, /playbackController\?\.startLoad\(/);
    assert.match(visibilityWatch, /playbackSourceChangedWhileSuspended[\s\S]*playbackController\?\.resume\(\)/);
    assert.match(player.script.content, /playbackController\.setSource\(playbackSource\.value, directFallbackSource\.value\);[\s\S]*?playbackSourceChangedWhileSuspended = true/);
});

test('mobile reels retain a decoded nearby frame and key players by media identity', async () => {
    const player = await readVue('../../resources/js/spa/apps/mobile/components/reels/ReelVideoPlayer.vue');
    const item = await readVue('../../resources/js/spa/apps/mobile/components/reels/ReelItem.vue');

    assert.match(player.script.content, /shouldWarmPlayback\.value\s*\|\|\s*state\.hasVisualFrame/);
    assert.match(item.template.content, /<ReelVideoPlayer[\s\S]*?v-bind:key="mediaItem\.id"/);
});

test('mobile feed remounts a player when the media identity changes', async () => {
    const publication = await readVue('../../resources/js/spa/apps/mobile/components/timeline/feed/parts/media/PublicationVideo.vue');

    assert.match(publication.template.content, /<VideoPlayer[\s\S]*?v-bind:key="mediaItem\.id"/);
});

test('HLS uses two-second segments and aligned two-second keyframes', async () => {
    const job = (await readFile(new URL('../../app/Jobs/User/Timeline/GeneratePostVideoHls.php', import.meta.url))).toString();

    assert.match(job, /SEGMENT_DURATION_SECONDS\s*=\s*2/);
    assert.match(job, /expr:gte\(t,n_forced\*'\.self::SEGMENT_DURATION_SECONDS/);
    assert.match(job, /'-hls_time',\s*\(string\) self::SEGMENT_DURATION_SECONDS/);
});
