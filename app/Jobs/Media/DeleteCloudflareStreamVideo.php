<?php

namespace App\Jobs\Media;

use App\Services\Media\Cloudflare\CloudflareStreamService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Throwable;

class DeleteCloudflareStreamVideo implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 8;
    public int $timeout = 45;

    public function __construct(public readonly string $uid)
    {
        $this->onConnection(config('media.queue_connection'));
        $this->onQueue(config('media.queues.cleanup'));
    }

    public function backoff(): array
    {
        return [60, 300, 900, 1800, 3600];
    }

    public function handle(CloudflareStreamService $stream): void
    {
        $stream->deleteVideo($this->uid);
    }

    public function failed(?Throwable $error): void
    {
        logger()->error('media.cloudflare_stream.cleanup_failed', [
            'uid' => $this->uid,
            'exception' => $error?->getMessage(),
        ]);
    }
}
