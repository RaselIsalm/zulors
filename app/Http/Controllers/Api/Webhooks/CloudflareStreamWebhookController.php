<?php

namespace App\Http\Controllers\Api\Webhooks;

use App\Enums\Media\MediaStatus;
use App\Enums\Post\PostStatus;
use App\Events\User\Timeline\MediaProcessedEvent;
use App\Events\User\Timeline\PublicTimelinePostCreatedEvent;
use App\Http\Controllers\Controller;
use App\Models\Media;
use App\Models\Post;
use App\Services\Media\Cloudflare\CloudflareStreamService;
use App\Traits\Http\Api\SupportsApiResponses;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class CloudflareStreamWebhookController extends Controller
{
    use SupportsApiResponses;

    public function __invoke(Request $request, CloudflareStreamService $stream)
    {
        if (! $this->hasValidSignature($request)) {
            return $this->responseUnauthorizedError();
        }

        $payload = $request->all();
        $uid = data_get($payload, 'uid')
            ?? data_get($payload, 'data.uid')
            ?? data_get($payload, 'video.uid')
            ?? data_get($payload, 'result.uid');
        if (blank($uid)) {
            return $this->responseSuccess();
        }

        $state = strtolower((string) (
            data_get($payload, 'status.state')
            ?? data_get($payload, 'data.status.state')
            ?? data_get($payload, 'state')
            ?? data_get($payload, 'data.state')
            ?? ''
        ));
        $ready = (bool) (data_get($payload, 'readyToStream') ?? data_get($payload, 'data.readyToStream') ?? false)
            || in_array($state, ['ready', 'complete', 'completed', 'published', 'live'], true);
        $failed = in_array($state, ['failed', 'error'], true);

        $mediaRows = Media::query()
            ->where(function ($query) use ($uid): void {
                $query->where('disk', 'cloudflare_stream')->where('source_path', $uid)
                    ->orWhere('metadata->stream->uid', $uid);
            })
            ->with('mediaable')
            ->get();

        foreach ($mediaRows as $media) {
            $metadata = $media->metadata ?? [];
            $isManagedR2 = (string) data_get($metadata, 'stream.uid') === (string) $uid;

            if ($isManagedR2) {
                $streamMetadata = (array) data_get($metadata, 'stream', []);
                $streamMetadata['state'] = $ready ? 'ready' : ($failed ? 'failed' : 'processing');
                $streamMetadata['updated_at'] = now()->toIso8601String();
                if ($ready) $streamMetadata['ready_at'] = now()->toIso8601String();
                if ($failed) {
                    $streamMetadata['error'] = data_get($payload, 'status.errorReasonText')
                        ?? data_get($payload, 'data.status.errorReasonText')
                        ?? 'Cloudflare Stream could not encode this source.';
                }
                $metadata['stream'] = $streamMetadata;
                if ($ready) {
                    $urls = $stream->playbackUrls((string) $uid);
                    $metadata['playback'] = array_merge((array) ($metadata['playback'] ?? []), [
                        'stream_hls' => $urls['hls'] ?? null,
                        'stream_dash' => $urls['dash'] ?? null,
                        'stream_thumbnail' => $urls['thumbnail'] ?? null,
                    ]);
                }
                $media->metadata = $metadata;
                $media->save();
            } else {
                // Keep historical Stream-only media working while using the
                // current signed webhook scheme for both old and pilot assets.
                $metadata['playback'] = $stream->playbackUrls($media->source_path);
                $metadata['upload_state'] = $ready ? 'ready' : ($failed ? 'failed' : 'processing');
                if ($ready) $media->status = MediaStatus::PROCESSED;
                if ($failed) $media->status = MediaStatus::FAILED;
                $media->metadata = $metadata;
                $media->save();
            }

            if ($media->mediaable instanceof Post) {
                if (! $isManagedR2 && $ready) {
                    $media->mediaable->status = PostStatus::ACTIVE;
                    $media->mediaable->save();
                }
                try {
                    event(new MediaProcessedEvent($media->refresh(), $media->mediaable->user_id));
                    if ($ready) event(new PublicTimelinePostCreatedEvent($media->mediaable->refresh()));
                } catch (\Throwable $error) {
                    Log::warning('Cloudflare Stream media update broadcast failed.', ['media_id' => $media->id, 'exception' => $error::class]);
                }
            }
        }

        return $this->responseSuccess();
    }

    private function hasValidSignature(Request $request): bool
    {
        $secret = (string) config('media.cloudflare.stream.webhook_secret');
        $header = (string) $request->header('Webhook-Signature', '');
        if ($secret === '' || $header === '') {
            return false;
        }

        $parts = [];
        foreach (explode(',', $header) as $part) {
            [$key, $value] = array_pad(explode('=', trim($part), 2), 2, null);
            if ($key !== null && $value !== null) $parts[$key] = $value;
        }

        $timestamp = $parts['time'] ?? '';
        $signature = strtolower((string) ($parts['sig1'] ?? ''));
        if (! ctype_digit((string) $timestamp) || ! preg_match('/\A[a-f0-9]{64}\z/', $signature)) {
            return false;
        }
        if (abs(now()->timestamp - (int) $timestamp) > 300) {
            return false;
        }

        $expected = hash_hmac('sha256', $timestamp.'.'.$request->getContent(), $secret);

        return hash_equals($expected, $signature);
    }
}
