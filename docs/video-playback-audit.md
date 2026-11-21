# Feed and Reels playback audit

## Root causes

The examined production sample did not point to an R2 or HLS outage: all 17
sampled videos had HLS playlists, and all 264 sampled playlist/segment requests
returned HTTP 200. Median TTFB was 115 ms, p95 was 579 ms, and 248 responses
were Cloudflare cache HITs. API smoke checks passed and Horizon was running.
This is a bounded sample, not a guarantee about every device, request, or time.

The main causes found in the client playback path were:

- Feed playback attached HLS only after the video became visible and the
  playback arbiter requested it. Feed prefetch also used `requestIdleCallback`,
  which could defer the cache warmup by as much as 2.5 seconds. That left the
  visible video waiting for a manifest and segment despite healthy CDN
  responses.
- Startup ABR could choose a low rendition from a coarse network estimate;
  the initial frame therefore looked soft before quality ramped up. The sampled
  production ladder had 720p at roughly 3.2–3.6 Mbps and no 1080p rendition, so
  the app cannot deliver 1080p for those assets without generating it.
- Reels could treat `loadeddata` or a very small network-profile buffer as
  playback-ready. That allowed playback to start with too little buffered media
  and stall during fast swipes or network variation.
- Reels route state was seeded from the tapped feed post, and a compatible HLS
  controller handoff existed, but fallback paths could still construct a new
  player. The transition did not consistently keep the poster visible while
  that player became ready.
- The service worker warmed a limited set of HLS resources but did not fetch
  enough duration for the configured startup buffer. Controller disposal was
  already bounded to the active/warm Reels window; this audit did not find
  evidence of a persistent controller leak.

The latest read-only production snapshot found 17/17 videos HLS-ready and
processed, no queued/delayed/reserved video jobs, Horizon and the Supervisor
service active, two video workers using at most 0.2% CPU each, no running
FFmpeg processes, and about 76 GB free on the worker scratch filesystem. Three
of the 17 HLS assets report the current v6 encoding version; all 17 remain
playable. This snapshot does not include whole-host CPU/RAM/load averages or
database query latency. An authenticated production browser run under
throttled network conditions is also not available yet. A public production
request observed during this change returned `/` as HTTP 302 with 2.28 s TTFB
and `/auth/login` as HTTP 200 with 0.84 s TTFB; these single unauthenticated
HTML requests do not measure video API or media delivery latency.

## Implemented changes

- Feed and Reels now prefer the highest available rendition up to 720p for the
  initial HLS selection, keep the full ABR ladder available, and remove the
  forced minimum bitrate. If startup has not accumulated five seconds of media
  within ten seconds, the player selects the highest rendition supported by
  its measured throughput. Sources without HD use their highest available
  level.
- Feed and active Reels wait for five seconds of buffered media before the
  first play request is allowed to start. The existing poster remains visible
  during this wait; direct MP4 fallback can start on a decoded frame after the
  ten-second deadline. Feed-to-Reels handoff marks transferred media ready so
  an already-buffered HLS controller can continue without waiting for a second
  startup buffer. The startup buffer requirement is capped by remaining media
  duration so clips shorter than five seconds can start when fully buffered.
  Reels starts its ten-second quality deadline when the active source attaches
  or its manifest is ready, rather than waiting for the first data event.
- Buffering indicators are suppressed during initial startup and shown only
  when playback has already begun and a stall lasts at least two seconds.
- Feed prefetch runs on a bounded short timer instead of waiting for idle time.
  The service worker warms the active HLS rendition through five seconds of
  segments and the next one or two videos through two seconds, depending on
  network profile. Offline and Data Saver continue to disable media prefetch.
- Both mobile and desktop player implementations use the same startup,
  handoff, buffering, and cleanup rules. Existing API and HLS storage formats
  are unchanged.

## Local verification

- `npm run test:ws`: 206 tests passed.
- `npx vite build --outDir /tmp/zulors-vite-build --emptyOutDir`: production
  Vite build passed.
- The focused playback/prefetch tests cover HD-first level selection,
  sustainable fallback, five-second current buffers, two-second next buffers,
  handoff readiness, and delayed buffering indicators.

## Performance limits and follow-up verification

The target is a visible poster immediately and a first frame under one second
for warm/prefetched playback on a fast connection. Waiting for five seconds of
media intentionally trades a longer cold start for fewer early stalls; cold
uncached media and connections slower than the selected rendition cannot be
guaranteed to start in under one second. With the sampled 720p bitrate, a
steady 3.2–3.6 Mbps plus protocol overhead is needed to sustain HD.

Before treating the production result as verified, collect host and database
metrics and run an authenticated mobile browser session on fast, moderate, and
throttled networks. Record first-frame time, first rendition, stall duration,
Cloudflare cache status, and feed-to-Reels handoff success. The current local
build and unit checks do not replace those live playback measurements.
