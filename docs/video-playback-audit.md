# Feed and Reels playback audit

## Findings from the repository

- Feed video elements rendered a poster and used `preload="metadata"`. The
  adaptive source was attached when the playback arbiter requested playback,
  so the active feed video could still wait for the HLS manifest and its first
  segment after it became visible. Service worker prefetch covered only one
  upcoming HLS video.
- Startup quality used a 5 Mbps estimate on slow connections and enforced an
  HD minimum automatic bitrate. That could select a rung the connection could
  not sustain and caused stalls despite HLS being available.
- Reels entry on mobile waited for the first-page request before it had a post
  to render. Feed-to-Reels navigation also created a new HLS player, discarding
  the feed player's attached MediaSource and buffered SourceBuffers. A black
  loading view was shown while the new post and player initialized.
- Reels playback warmed only the immediate next item, and page fetching began
  near the end of the current list. Reels already destroy HLS instances when
  players leave the warm window; the repository did not show a controller
  disposal leak.
- The HLS pipeline and Cloudflare R2 custom media domain were already present.
  The HLS feature flag defaulted off. MP4 fast-start (`moov` before media data),
  immutable cache headers, range support, and the R2 playback CORS check were
  already implemented. Repository code cannot establish whether production
  requests hit Cloudflare cache or what their real TTFB, RTT, or throughput is.

These are code-level causes and constraints, not a measurement of a particular
production request. The feed response now includes `Server-Timing` for server
processing duration; client playback metrics already record first-frame time,
stalls, recovery, rendition, and terminal errors. Cloudflare cache status and
real slow-network playback still require a deployed device/session to verify.

## Changes

- The feed playback window now prefetches the active HLS video and up to two
  upcoming videos on normal connections, or one on slow connections. Reels use
  the same one/two-item lookahead, bounded neighbor buffers, and earlier page
  fetching. Offline and Data Saver modes continue to skip network prefetch.
- Startup selects a rendition from the coarse network estimate and leaves the
  full ABR ladder available. HLS can step below the startup rung when segment
  throughput is lower than the estimate.
- Feed-to-Reels entry puts the tapped post and poster on screen before the
  route's network refresh completes. When the feed has an active HLS.js session,
  it transfers that same controller, MediaSource, SourceBuffers, and playback
  position into the Reels element. If transfer is unavailable, the seeded post,
  poster, and prefetched HLS objects still provide the quick-start path. A
  short-lived handoff token ensures abandoned controllers are released.
- HLS generation is enabled by default for new eligible media. Existing R2
  videos can be backfilled with bounded `media:reconcile-reel-hls` batches;
  this repository change does not run jobs against a configured production
  queue or database.

## Performance limits

Warm handoff avoids restarting a loaded HLS session. A cold cache, high RTT,
poor radio conditions, a missing poster, browser autoplay restrictions, or an
unavailable HLS rendition can still delay the first decoded frame. The app
keeps the poster visible instead of exposing an empty black surface while it
waits. A sub-second target should be measured on representative devices and
networks; it cannot be guaranteed for every uncached slow connection.
