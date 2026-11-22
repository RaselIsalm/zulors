<?php

namespace App\Jobs\Media;

use App\Models\Media;
use App\Models\Post;
use App\Models\StoryFrame;
use App\Services\Media\Cloudflare\CloudflareStreamService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\Middleware\WithoutOverlapping;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Throwable;

class IngestR2VideoToCloudflareStream implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 5;
    public int $timeout = 90;

    public function __construct(public readonly int $mediaId)
    {
        $this->onConnection(config('media.queue_connection'));
        $this->onQueue(config('media.queues.video_normal'));
    }

    public function middleware(): array
    {
        return [(new WithoutOverlapping('cloudflare-stream-media:'.$this->mediaId))
            ->releaseAfter(60)->expireAfter($this->timeout + 60)];
    }

    public function backoff(): array
    {
        return [60, 180, 600, 1200];
    }

    public function handle(CloudflareStreamService $stream): void
    {
        $media = Media::with('mediaable')->find($this->mediaId);
        if (! $media || ! $media->type?->isVideo()) {
            return;
        }

        $ownerId = $this->ownerId($media);
        if (! $stream->isPilotUser($ownerId)) {
            return;
        }

        $metadata = $media->metadata ?? [];
        if (data_get($metadata, 'stream.state') === 'ready' && filled(data_get($metadata, 'stream.uid'))) {
            return;
        }
        if ($media->disk !== (string) config('media.cloudflare.r2.final_disk', 'r2_final')
            || data_get($metadata, 'provider') !== 'r2') {
            $this->updateState($media, 'skipped', 'not_canonical_r2_media');
            return;
        }
        if (! Storage::disk($media->disk)->exists($media->source_path)) {
            throw new \RuntimeException('The R2 playback source is unavailable for Stream ingestion.');
        }

        if ((float) data_get($media->metadata, 'duration_seconds', 0) <= 0) {
            $this->updateState($media, 'skipped', 'unknown_duration');
            return;
        }

        if ($stream->deliveredBudgetReached()) {
            $this->updateState($media, 'skipped', 'delivered_minutes_guardrail');
            return;
        }

        $lockKey = 'media:cloudflare-stream:ingest:'.(string) config('media.cloudflare.stream.account_id');
        Cache::lock($lockKey, 120)->block(20, function () use ($stream, $media): void {
            $fresh = Media::find($media->id);
            if (! $fresh || data_get($fresh->metadata, 'stream.state') === 'ready') {
                return;
            }

            try {
                $this->updateState($fresh, 'processing');
                $asset = $stream->ingestFromR2($fresh);
                $uid = (string) data_get($asset, 'uid');
                $urls = $stream->playbackUrls($uid);
                $metadata = DB::transaction(function () use ($fresh, $asset, $uid, $urls): array {
                    $locked = Media::query()->lockForUpdate()->find($fresh->id);
                    if (! $locked) return [];
                    $metadata = $locked->metadata ?? [];
                    $metadata['stream'] = array_merge((array) data_get($metadata, 'stream', []), [
                        'state' => (bool) data_get($asset, 'readyToStream') ? 'ready' : 'processing',
                        'uid' => $uid,
                        'creator' => 'zulors-media-'.$locked->id,
                        'estimated_minutes' => max(1, (int) ceil((float) data_get($metadata, 'duration_seconds', 0) / 60)),
                        'ingest_started_at' => data_get($metadata, 'stream.ingest_started_at') ?: now()->toIso8601String(),
                        'ingest_updated_at' => now()->toIso8601String(),
                        'error' => null,
                    ]);
                    $metadata['playback'] = array_merge((array) ($metadata['playback'] ?? []), [
                        'stream_hls' => $urls['hls'] ?? null,
                        'stream_dash' => $urls['dash'] ?? null,
                        'stream_thumbnail' => $urls['thumbnail'] ?? null,
                    ]);
                    $locked->metadata = $metadata;
                    $locked->save();
                    return $metadata;
                });

                logger()->info('media.cloudflare_stream.ingest_requested', [
                    'media_id' => $fresh->id,
                    'estimated_minutes' => data_get($metadata, 'stream.estimated_minutes'),
                    'ready' => (bool) data_get($asset, 'readyToStream'),
                ]);
            } catch (Throwable $error) {
                if (str_contains($error->getMessage(), 'pilot storage-minute cap reached')) {
                    $this->updateState($fresh, 'skipped', 'stored_minutes_cap');
                    return;
                }
                $this->updateState($fresh, 'retrying', null, $error::class);
                throw $error;
            }
        });
    }

    public function failed(?Throwable $error): void
    {
        if ($media = Media::find($this->mediaId)) {
            $this->updateState($media, 'failed', null, $error ? $error::class : null);
        }
    }

    private function ownerId(Media $media): ?int
    {
        $mediaable = $media->mediaable;

        return match (true) {
            $mediaable instanceof Post => (int) $mediaable->user_id,
            $mediaable instanceof StoryFrame => (int) $mediaable->story?->user_id,
            default => null,
        };
    }

    private function updateState(Media $media, string $state, ?string $reason = null, ?string $error = null): void
    {
        DB::transaction(function () use ($media, $state, $reason, $error): void {
            $locked = Media::query()->lockForUpdate()->find($media->id);
            if (! $locked) return;
            $metadata = $locked->metadata ?? [];
            $stream = (array) data_get($metadata, 'stream', []);
            $stream['state'] = $state;
            $stream['updated_at'] = now()->toIso8601String();
            if ($reason) $stream['reason'] = $reason;
            if ($error) $stream['error_type'] = class_basename($error);
            $metadata['stream'] = $stream;
            $locked->metadata = $metadata;
            $locked->save();
        });
    }
}
