<?php

namespace App\Services\Media;

use App\Models\Media;
use App\Jobs\User\Timeline\GeneratePostVideoHls;
use Illuminate\Support\Facades\Log;
use Throwable;

final class ReelsHlsRollout
{
    public function processingEnabled(): bool
    {
        return (bool) config('media.reels_hls.enabled', false);
    }

    public function dispatch(Media $media, bool $highPriority = false): void
    {
        if (! $this->processingEnabled()) {
            return;
        }

        try {
            $job = GeneratePostVideoHls::dispatch((int) $media->id);
            $queue = $highPriority
                ? config('media.queues.video_high', config('media.queues.video'))
                : config('media.queues.video');

            $job->onQueue((string) $queue);
            $job->afterCommit();
        } catch (Throwable $exception) {
            Log::warning('Unable to enqueue R2 video HLS processing; stale-job recovery will retry it.', [
                'exception' => $exception::class,
            ]);
        }
    }
}
