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
    assert.doesNotMatch(visibilityWatch, /playbackController\?\.startLoad\(/);
    assert.match(visibilityWatch, /playbackSourceChangedWhileSuspended = false/);
    assert.match(player.script.content, /playbackController\.setSource\(playbackSource\.value, directFallbackSource\.value\);[\s\S]*?playbackSourceChangedWhileSuspended = true/);
    assert.match(player.script.content, /isReady: Boolean\(playbackSource\.value\.url\) && ! state\.isScrubbing/);
    assert.match(player.script.content, /if\(! playbackAttached\)[\s\S]*playbackController\?\.attach\(playbackSource\.value, directFallbackSource\.value\)/);
});

test('mobile reels retain a decoded nearby frame and key players by media identity', async () => {
    const player = await readVue('../../resources/js/spa/apps/mobile/components/reels/ReelVideoPlayer.vue');
    const item = await readVue('../../resources/js/spa/apps/mobile/components/reels/ReelItem.vue');

    assert.match(player.script.content, /shouldWarmPlayback\.value\s*\|\|\s*state\.hasVisualFrame/);
    assert.match(player.script.content, /watch\(\s*\(\) => \[sourceUrl\.value, playbackSource\.value\.transport, directPlaybackSource\.value\?\.url/);
    assert.match(item.template.content, /<ReelVideoPlayer[\s\S]*?v-bind:key="mediaItem\.id"/);
});

test('desktop reels reattach a source when the warmed seed receives its canonical URL', async () => {
    const player = await readVue('../../resources/js/spa/apps/desktop/components/reels/ReelVideoPlayer.vue');

    assert.match(player.script.content, /watch\(\s*\(\) => \[sourceUrl\.value, playbackSource\.value\.transport, directPlaybackSource\.value\?\.url/);
    assert.match(player.script.content, /configurePlaybackSource\(\);[\s\S]*?syncPlaybackWindow\(\);[\s\S]*?playVideo\(\);/);
});

for(const platform of Object.values({ mobile: 'mobile', desktop: 'desktop' })) {
    test(`${platform} reels use a direct handoff fallback and restore lifecycle resume state`, async () => {
        const player = await readVue(`../../resources/js/spa/apps/${platform}/components/reels/ReelVideoPlayer.vue`);

        assert.match(player.script.content, /hasTransferredHandoff = Boolean\(props\.handoff\?\.handoffToken\)/);
        assert.match(player.script.content, /state\.forceMp4Fallback = true/);
        assert.match(player.script.content, /rememberReelResumePosition/);
        assert.match(player.script.content, /normalizeReelResumePosition/);
        assert.match(player.script.content, /zulors:app-resume/);
        assert.match(player.script.content, /applyRememberedResumePosition\(\{ resetBelowThreshold: true \}\)/);
    });
}

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
