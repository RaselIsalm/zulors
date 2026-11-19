# Adaptive video playback and HLS processing

Post video publication queues FFmpeg optimization after the verified R2 upload.
The worker archives an exact original in R2, creates an H.264/AAC MP4 and
thumbnail, then queues HLS. When HLS processing is enabled,
`GeneratePostVideoHls` reads the current optimized playback MP4 and creates a
master playlist plus 240p, 360p, 480p, 720p and 1080p renditions, capped at the
source height. The master playlist is published only after its segments are
uploaded. If optimization exhausts its retries, the raw MP4 stays playable and
HLS can be generated from it as a fallback.

The production media pipeline serves these public R2 objects through the
Cloudflare cached custom domain (`media.zulors.com`). Playlists and segments
receive `public, max-age=31536000, immutable` cache headers. R2 serves byte
ranges for direct MP4 requests; the service worker passes range requests through
instead of storing incomplete media responses. The web and mobile feed players
prefer HLS, use HLS.js where native HLS is unavailable, and fall back to the
MP4 if adaptive playback cannot start.

The final bucket (`zulors-media-final`) must allow cross-origin `GET` and
`HEAD` playback from the website origins and allow the `Range` request header.
Apply `deploy/r2-final-playback-cors.json` at Cloudflare Dashboard → R2 →
`zulors-media-final` → Settings → CORS Policy, then purge the
`media.zulors.com` cache so cached objects receive the updated CORS headers.
`deploy/check-r2-playback-cors.php`
creates and deletes a no-store probe object while checking preflight, playlist
reads, HEAD requests, byte ranges, and exposed `Content-Range` headers. Live
deployments run this check before promoting a release.

Feed cards render the thumbnail first. The video player attaches playback near
the viewport. HLS.js warms only the next Reel, starts at the lowest rendition,
and stops after about 3.5 seconds are buffered. It does not prewarm offline or
when Data Saver is enabled. Active playback can adapt through the full ladder;
off-screen players pause and release their buffered source, and the feed
playback arbiter allows one visible video to play at a time. Native playback
uses browser-controlled metadata preloading. This reduces the next-slide wait
on supported HLS.js clients, but cannot guarantee zero startup delay on slow or
unavailable networks.

## Rollout controls

```env
MEDIA_REELS_HLS_ENABLED=true
MEDIA_REELS_HLS_TIMEOUT_SECONDS=21600
MEDIA_REELS_HLS_STALE_AFTER_MINUTES=120
```

FFmpeg with `libx264` and AAC support must be available to the Horizon workers
consuming `media-video-high` (new MP4 optimization) and the configured normal
video queue (HLS; live legacy alias `media-video`). Post MP4 optimization runs
for newly published R2 post videos. The HLS flag
controls rendition generation and HLS URL exposure for all viewers. Turning
the flag off immediately makes
R2 playback use the MP4 again; Cloudflare Stream media keeps its existing
playback path. Previously uploaded MP4s are not batch-transcoded by deploy;
they remain playable and can be queued in bounded batches with
`--rebuild --limit=200`.

The additive `MediaResource` metadata reports `playback_state`,
`background_processing_state`, and `metadata.playback.hls_state` with rendition
readiness. The R2 MP4 `source_url` remains present for old clients. No database
migration or new public endpoint is needed.

## Recovery and observation

The scheduler runs `media:reconcile-reel-hls` every five minutes. It requeues
R2 jobs whose heartbeat is older than the configured stale limit. Terminally
failed jobs remain MP4-playable and can be explicitly requeued with:

```bash
php artisan media:reconcile-reel-hls --retry-failed
```

Queue outdated renditions in bounded batches after deploying an encoding
version change:

```bash
php artisan media:reconcile-reel-hls --rebuild --limit=200
```

The worker logs queue age, encode duration, rendition count and completion
outcome to the performance log. Client performance events include play
requests, first-frame duration, stalls, successful recoveries, selected
rendition and terminal playback failures. Those events contain only route,
client variant and coarse network/device classes; they do not include media
URLs or user, post, media or persistent device IDs.

Monitor first-frame duration, stall and recovery rates, processing queue age,
HLS rendition readiness and MP4 fallback rate after rollout. Encoding increases
worker CPU use and adds HLS objects to R2 storage; each newly processed video
also retains its original upload, increasing storage use.
