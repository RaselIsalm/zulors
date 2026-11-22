# Background Publications

> Current source note (2026-11-21): uploads still go directly to R2, which remains
> the canonical source. Eligible post/story videos can then be optimized by the
> existing media workers. An explicitly configured, allowlisted Cloudflare Stream
> pilot imports the finished R2 playback object for managed HLS; the pilot is off
> by default. See [upload-flow-audit.md](upload-flow-audit.md) for the flow.

## Scope

Background publications let a user select media, press Publish or Send, leave the
editor, and watch progress from Home or Chat. The server creates the post, story or
message after R2 verifies each uploaded object and stores its R2 key. Post/story
video optimization and optional Stream managed playback are background steps.

The browser publication outbox uses the existing R2 temp/final buckets and shared
Redis/cache for idempotency. A bounded local JPEG poster is captured from a selected
video and stored next to its R2 object, so feed/story surfaces have a real frame while
playback processing runs. The pilot never uploads user bytes directly to Stream; it
asks Stream to fetch the final R2 object through the public cached media domain after
the R2 object is verified and existing post/story processing has completed. R2 remains the fallback whenever Stream is not
ready or unavailable. Audio/document upload behavior is unchanged.

As of the 2026-09-09 live deployment and follow-up activation, the code, migration,
routes and scheduler entry are deployed to https://zulors.com, and
`MEDIA_PUBLICATIONS_ENABLED=true` admits the browser/WebView-compatible background
publication path on the live site. Direct-only enforcement remains off for older
clients. Native Android notification/background transfer is not accepted until the
0.5.0 APK is installed and tested on a real Samsung device.

## Feature Flags

```dotenv
MEDIA_PUBLICATIONS_ENABLED=true
MEDIA_PUBLICATIONS_ALLOWED_USER_IDS=
MEDIA_PUBLICATIONS_PER_USER_LIMIT=2
MEDIA_PUBLICATIONS_VIDEO_LIMIT=20
MEDIA_PUBLICATIONS_MAX_QUEUE_AGE_SECONDS=900
MEDIA_PUBLICATIONS_IMAGE_MAX_BYTES=20971520
MEDIA_PUBLICATIONS_TIMEOUT=21600
```

`MEDIA_PUBLICATIONS_ENABLED=true` accepts new background-publication admissions.
Setting it back to `false` is the first rollback step; already admitted publications
can still resume, complete, cancel and reconcile during rollback. Use
`MEDIA_PUBLICATIONS_ALLOWED_USER_IDS` to narrow admission to canary accounts instead
of leaving it global.

The current canary API only accepts `privacy=all`. Existing restricted post/story
flows remain on the legacy routes until a larger privacy enforcement change is made.

## API

Authenticated user routes are under `/api/media-publications`:

- `GET /capabilities`
- `POST /`
- `GET /`
- `GET /{publication}`
- `POST /{publication}/items/{item}/resume`
- `POST /{publication}/items/{item}/complete`
- `POST /{publication}/retry`
- `DELETE /{publication}`

Create requires a client-generated `client_uid`. Repeating the same request returns
the same publication. Reusing the same `client_uid` with different content returns
409. Attachments also carry client IDs so Android and browser queues can reconcile
the same work without duplicate posts.

Publication status moves through `uploading`, `processing`, `publishing`, and
`published`, with `waiting`, `failed`, and `cancelled` for non-happy paths. Raw
uploads remain private in `r2_temp`; after verification, R2 promotes each object to
`r2_final` with a storage-side copy. No media body is sent through Laravel.

## Android

The Android WebView bridge accepts messages only from the trusted HTTPS main frame and
stores selected files in app-private storage before the editor leaves. Large files are
not sent through the JavaScript bridge as base64.

Android 14+ uses a user-initiated data transfer `JobService`. Older supported Android
versions use foreground `WorkManager`. One transfer runs per device, with at most two
multipart parts in flight. Upload progress updates one ongoing notification at most
once per second. If the user force-stops the app or powers off the device, active
transfer continuity is not guaranteed; completed server-side processing continues.

Production APKs must be built with the existing signing identity. A debug APK can
verify compilation and local behavior, but it may not update an installed production
build if the signatures differ.

## Browser

The web path uses an IndexedDB-backed upload manager and a tab lease so multiple tabs
do not upload the same publication at the same time. Navigation inside the site keeps
uploads alive. Closing the browser is not guaranteed to keep uploading; on reopen the
manager reconciles and resumes when the File/Blob reference is still available. If the
browser cannot persist the selected file, the user must reselect it before retry.

Home shows owner-only progress rows. Chat shows sender-only pending bubbles. Upload
percentage and server processing status are separate states.

## Processing Profile

New publications store `balanced_v1` at creation time, so future tuning does not change
already accepted work.

Eligible images are auto-oriented, stripped of unnecessary metadata, converted to
WebP quality 86, and capped to a 2048px long edge in a browser worker when that
reduces size. Otherwise, the original image is retained. GIF and animated PNG/WebP
are intentionally rejected from this path.

Videos and documents are unchanged. Video is stored and served from R2 as provided;
R2 itself does not encode or compress media. Post/story jobs create the app's
optimized playback MP4 and thumbnail. For eligible pilot accounts, a separate
Cloudflare Stream import runs from the processed R2 object and switches playback
to Stream HLS only after the signed webhook confirms `readyToStream`. The original
R2 playback remains available throughout processing and on any failure. The initial
R2 video is not guaranteed to support immediate playback on every browser/device
codec; the poster stays visible until a video frame is decoded.

The managed Stream pilot is disabled unless all of these are configured:

```dotenv
CLOUDFLARE_STREAM_ENABLED=true
CLOUDFLARE_STREAM_PILOT_USER_IDS=123,456
CLOUDFLARE_STREAM_ACCOUNT_ID=...
CLOUDFLARE_STREAM_API_TOKEN=...
CLOUDFLARE_STREAM_WEBHOOK_SECRET=...
CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN=customer-....cloudflarestream.com
CLOUDFLARE_STREAM_STORED_MINUTES_CAP=1000
CLOUDFLARE_STREAM_DELIVERED_MINUTES_GUARDRAIL=20000
```

The token needs Stream read/write access. Register the app webhook at
`POST /api/webhooks/cloudflare/stream` and use Cloudflare's `Webhook-Signature`
secret. The app validates the signed raw body and rejects stale signatures. Stream
ingestion uses a unique creator ID so retries can find and reuse the same remote
asset. A monthly storage-minute reservation prevents concurrent pilot jobs from
crossing the configured cap. Delivered minutes use authenticated feed watch-time
telemetry plus a conservative full-frame estimate for each unique Story view.
This is not Cloudflare's invoice counter: replayed Stories and already-loaded
players can differ. At 95% of the estimate, new imports stop and newly serialized
media falls back to R2 within the cache window. Compare the estimate with
Cloudflare billing/analytics before increasing the cap.
Deleting an app media item queues deletion of its Stream derivative; R2 remains the
source of truth.

Compression is server-side. Original and optimized byte counts are recorded, but no
specific final MB size is guaranteed for every file.

## Rollout Checks

1. Deploy with `MEDIA_PUBLICATIONS_ENABLED=false`.
2. Confirm migrations, Horizon, scheduler, CORS, lifecycle, and existing legacy uploads.
3. Enable `MEDIA_PUBLICATIONS_ENABLED=true` for one test account via
   `MEDIA_PUBLICATIONS_ALLOWED_USER_IDS`.
4. The live site was later opened globally by leaving
   `MEDIA_PUBLICATIONS_ALLOWED_USER_IDS` empty.
5. Test Post image/video first, then Story and Chat, using Wi-Fi and cellular.
6. Test minimize, screen lock, app reopen, retry, cancel, auth expiry, and network
   interruption on a real Android device.
7. Run one representative 500 MB+ browser/app video and at most two simultaneous uploads.
8. Watch upload failure/resume rate, R2 temp/final object counts, R2 stored bytes,
   rejected PHP upload bytes, VPS media-temp disk use and web latency. Stop rollout
   if duplicate publication or unexpected VPS media-body traffic appears.

Rollback is config-first: set `MEDIA_PUBLICATIONS_ENABLED=false`, clear Laravel config
cache, and gracefully restart Horizon. Existing admitted rows stay recoverable or
cancellable through the status/resume/cancel endpoints.
