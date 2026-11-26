<?php

namespace App\Jobs\Media;

use App\Models\Post;
use App\Models\StoryFrame;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Storage;

class DeleteVideoHlsAssets implements ShouldBeUnique, ShouldQueue
{
	use Dispatchable;
	use InteractsWithQueue;
	use Queueable;

	public int $tries = 5;

	public function __construct(
		public readonly string $disk,
		public readonly string $prefix,
		public readonly string $mediaableType,
		public readonly int $mediaId,
	) {
		$this->onConnection(config('media.queue_connection'));
		$this->onQueue(config('media.queues.cleanup'));
	}

	public function uniqueId(): string
	{
		return 'delete-video-hls:'.sha1($this->disk.'|'.$this->prefix);
	}

	public function handle(): void
	{
		$expectedBase = match ($this->mediaableType) {
			Post::class => 'uploads/posts/videos',
			StoryFrame::class => 'uploads/stories/videos',
			default => null,
		};

		if ($expectedBase === null
			|| ! preg_match('/\A[a-f0-9]{24}\z/', basename($this->prefix))
			|| dirname($this->prefix) !== $expectedBase.'/'.$this->mediaId.'/hls') {
			return;
		}

		Storage::disk($this->disk)->deleteDirectory($this->prefix);
	}
}
