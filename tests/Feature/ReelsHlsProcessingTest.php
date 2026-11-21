<?php

namespace Tests\Feature;

use App\Enums\Media\MediaStatus;
use App\Enums\Media\MediaType;
use App\Enums\Post\PostStatus;
use App\Enums\Post\PostType;
use App\Enums\User\UserStatus;
use App\Http\Resources\User\Media\MediaResource;
use App\Jobs\User\Timeline\GeneratePostVideoHls;
use App\Models\Media;
use App\Models\Post;
use App\Models\User;
use App\Services\Filesystem\Upload\VideoUploadService;
use App\Services\Media\ReelsHlsRollout;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Mockery;
use RuntimeException;
use Tests\TestCase;

class ReelsHlsProcessingTest extends TestCase
{
    use RefreshDatabase;

    public function test_hls_rendition_ladder_uses_the_source_short_edge_without_upscaling(): void
    {
        $this->assertSame(2, GeneratePostVideoHls::SEGMENT_DURATION_SECONDS);
        $this->assertSame([240, 360, 480, 720], GeneratePostVideoHls::renditionShortEdgesForSource(720, 1280));
        $this->assertSame([240, 360, 480, 720], GeneratePostVideoHls::renditionShortEdgesForSource(1280, 720));
        $this->assertSame([240, 360, 480, 720, 1080], GeneratePostVideoHls::renditionShortEdgesForSource(1080, 1920));
        $this->assertSame([240, 360, 480, 720, 1080], GeneratePostVideoHls::renditionShortEdgesForSource(3840, 2160));
        $this->assertSame([], GeneratePostVideoHls::renditionShortEdgesForSource(180, 320));
        $this->assertSame(['width' => 720, 'height' => 1280], GeneratePostVideoHls::renditionDimensions(720, 1280, 720));
        $this->assertSame(['width' => 1080, 'height' => 1920], GeneratePostVideoHls::renditionDimensions(1080, 1920, 1080));
        $this->assertSame(['width' => 1280, 'height' => 720], GeneratePostVideoHls::renditionDimensions(1920, 1080, 720));
        $this->assertSame(3400000, GeneratePostVideoHls::renditionProfile(720)['video']);
        $this->assertSame(6200000, GeneratePostVideoHls::renditionProfile(1080)['video']);
    }

    public function test_r2_disks_bound_connection_and_request_timeouts(): void
    {
        foreach (['r2_temp', 'r2_final'] as $disk) {
            $this->assertSame(10.0, (float) config("filesystems.disks.{$disk}.http.connect_timeout"));
            $this->assertSame(180.0, (float) config("filesystems.disks.{$disk}.http.timeout"));
        }
    }

    public function test_redis_reservation_timeout_exceeds_the_hls_job_timeout(): void
    {
        $this->assertGreaterThanOrEqual(
            (int) config('media.reels_hls.timeout_seconds') + 300,
            (int) config('queue.connections.redis.retry_after')
        );
    }

    public function test_hls_uses_the_exact_original_archive_when_it_exists(): void
    {
        Storage::fake('r2_final');
        Storage::disk('r2_final')->put('uploads/posts/videos/originals/1/source.mov', 'exact source upload');
        $media = $this->video($this->createPost($this->user()), [
            'original_storage' => [
                'disk' => 'r2_final',
                'path' => 'uploads/posts/videos/originals/1/source.mov',
                'size' => 999,
                'mime' => 'video/quicktime',
                'extension' => 'mov',
            ],
        ]);

        $method = new \ReflectionMethod(GeneratePostVideoHls::class, 'sourceDescriptor');
        $method->setAccessible(true);
        $source = $method->invoke(new GeneratePostVideoHls((int) $media->id), $media);

        $this->assertSame('r2_final', $source['disk']);
        $this->assertSame('uploads/posts/videos/originals/1/source.mov', $source['path']);
        $this->assertSame(999, $source['size']);
        $this->assertSame('video/quicktime', $source['mime']);
        $this->assertSame('mov', $source['extension']);
    }

    public function test_hls_falls_back_to_the_playback_mp4_if_the_original_archive_is_missing(): void
    {
        Storage::fake('r2_final');
        $media = $this->video($this->createPost($this->user()), [
            'original_storage' => [
                'disk' => 'r2_final',
                'path' => 'uploads/posts/videos/originals/missing/source.mov',
                'size' => 999,
                'mime' => 'video/quicktime',
                'extension' => 'mov',
            ],
        ]);

        $method = new \ReflectionMethod(GeneratePostVideoHls::class, 'sourceDescriptor');
        $method->setAccessible(true);
        $source = $method->invoke(new GeneratePostVideoHls((int) $media->id), $media);

        $this->assertSame($media->disk, $source['disk']);
        $this->assertSame($media->source_path, $source['path']);
        $this->assertSame((int) $media->size, $source['size']);
        $this->assertSame('mp4', $source['extension']);
    }

    public function test_failed_mp4_optimization_queues_hls_from_the_still_playable_r2_source(): void
    {
        Queue::fake();
        config(['media.reels_hls.enabled' => true]);
        Storage::fake('r2_final');
        $media = $this->video($this->createPost($this->user()), [
            'processing_mode' => 'original_direct',
            'upload_state' => 'uploaded',
            'background_processing_state' => 'failed',
            'playback' => ['hls_state' => 'skipped'],
        ]);

        $job = new \App\Jobs\User\Timeline\ConvertAndCompressPostVideo($media->mediaable);
        $job->failed(new RuntimeException('simulated optimizer failure'));

        $media->refresh();
        $this->assertSame('queued', data_get($media->metadata, 'background_processing_state'));
        $this->assertSame('queued', data_get($media->metadata, 'playback.hls_state'));
        Queue::assertPushed(GeneratePostVideoHls::class, fn (GeneratePostVideoHls $queued): bool => $queued->mediaId === (int) $media->id);
    }

    public function test_r2_hls_url_is_exposed_to_all_viewers_when_enabled_and_internal_signature_is_hidden(): void
    {
        Storage::fake('r2_final');
        config(['media.reels_hls.enabled' => true]);
        $owner = $this->user();
        $post = $this->createPost($owner);
        $media = $this->video($post, [
            'playback_state' => 'ready',
            'background_processing_state' => 'processed',
            'playback' => [
                'hls' => 'https://cdn.example.test/master.m3u8',
                'hls_state' => 'ready',
                'hls_source_signature' => 'private-signature',
                'renditions' => [['height' => 360, 'state' => 'ready']],
            ],
        ]);

        $viewers = [$this->user(), $this->user(), null];

        foreach ($viewers as $viewer) {
            $visible = $this->resourceFor($media, $viewer);
            $this->assertStringContainsString('uploads/posts/source.mp4', $visible['source_url']);
            $this->assertSame('https://cdn.example.test/master.m3u8', $visible['metadata']['playback']['hls']);
            $this->assertArrayNotHasKey('hls_source_signature', $visible['metadata']['playback']);
            $this->assertSame('ready', $visible['metadata']['playback_state']);
            $this->assertSame('processed', $visible['metadata']['background_processing_state']);
            $this->assertSame('ready', $visible['metadata']['playback']['renditions'][0]['state']);
        }

        config(['media.reels_hls.enabled' => false]);
        $disabled = $this->resourceFor($media, $viewers[0]);
        $this->assertArrayNotHasKey('hls', $disabled['metadata']['playback']);
    }

    public function test_cloudflare_stream_playback_is_unchanged_by_the_r2_hls_rollout_gate(): void
    {
        Storage::fake('r2_final');
        config(['media.reels_hls.enabled' => false]);
        $owner = $this->user();
        $post = $this->createPost($owner);
        $media = $this->video($post, [
            'provider' => 'cloudflare_stream',
            'playback' => ['hls' => 'https://videodelivery.net/uid/manifest/video.m3u8'],
        ]);

        $resource = $this->resourceFor($media, $owner);
        $this->assertSame('https://videodelivery.net/uid/manifest/video.m3u8', $resource['metadata']['playback']['hls']);
    }

    public function test_low_resolution_r2_source_is_marked_skipped_while_mp4_stays_playback_ready(): void
    {
        Event::fake();
        Storage::fake('r2_final');
        Storage::disk('r2_final')->put('uploads/posts/source.mp4', 'original mp4');
        config(['media.reels_hls.enabled' => true]);
        $media = $this->video($this->createPost($this->user()), [
            'provider' => 'r2',
            'playback_state' => 'ready',
            'background_processing_state' => 'queued',
            'background_processing_dispatched_at' => now()->subMinute()->toIso8601String(),
        ]);

        $probe = Mockery::mock(VideoUploadService::class);
        $probe->shouldReceive('getVideoDimensions')->once()->andReturn(['width' => 320, 'height' => 180]);

        (new GeneratePostVideoHls((int) $media->id))->handle($probe, app(ReelsHlsRollout::class));

        $media->refresh();
        $this->assertSame(MediaStatus::PROCESSED, $media->status);
        $this->assertSame('uploads/posts/source.mp4', $media->source_path);
        $this->assertSame('ready', data_get($media->metadata, 'playback_state'));
        $this->assertSame('skipped', data_get($media->metadata, 'background_processing_state'));
        $this->assertSame('skipped', data_get($media->metadata, 'playback.hls_state'));
        $this->assertSame(GeneratePostVideoHls::ENCODING_VERSION, data_get($media->metadata, 'playback.encoding_version'));
        $this->assertNull(data_get($media->metadata, 'playback.hls'));
        Storage::disk('r2_final')->assertExists('uploads/posts/source.mp4');
    }

    public function test_original_portrait_1080p_source_produces_an_adaptive_1080p_hls_rendition(): void
    {
        $binary = (new \Symfony\Component\Process\ExecutableFinder())->find('ffmpeg');
        if (! $binary) {
            $this->markTestSkipped('FFmpeg is required for the HLS encoding integration test.');
        }

        Event::fake();
        Storage::fake('r2_final');
        config(['media.reels_hls.enabled' => true, 'media.cache.control' => 'public, max-age=31536000, immutable']);
        $post = $this->createPost($this->user());
        $media = $this->video($post, [
            'provider' => 'r2',
            'playback_state' => 'ready',
            'background_processing_state' => 'queued',
            'background_processing_dispatched_at' => now()->subMinute()->toIso8601String(),
            'original_storage' => [
                'disk' => 'r2_final',
                'path' => 'uploads/posts/videos/originals/private/source.mp4',
                'extension' => 'mp4',
                'mime' => 'video/mp4',
                'size' => 12,
            ],
        ]);

        $resource = $this->resourceFor($media, $post->user);
        $this->assertArrayNotHasKey('original_storage', $resource['metadata']);

        $disk = Storage::disk('r2_final');
        $sourcePath = 'fixtures/reel-1080.mp4';
        $disk->makeDirectory(dirname($sourcePath));
        $sourceAbsolutePath = $disk->path($sourcePath);
        (new \Symfony\Component\Process\Process([
            $binary, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=24',
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1.5',
            '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-shortest', $sourceAbsolutePath,
        ]))->setTimeout(120)->mustRun();
        $sourceBytes = file_get_contents($sourceAbsolutePath);
        $sourceSize = strlen($sourceBytes);
        $disk->put($media->source_path, $sourceBytes);
        $originalPath = 'uploads/posts/videos/originals/'.$media->id.'/source.mp4';
        $disk->put($originalPath, $sourceBytes);
        $media->size = $sourceSize;
        $media->metadata = array_merge($media->metadata, [
            'original_storage' => [
                'disk' => 'r2_final',
                'path' => $originalPath,
                'extension' => 'mp4',
                'mime' => 'video/mp4',
                'size' => $sourceSize,
            ],
        ]);
        $media->save();

        (new GeneratePostVideoHls((int) $media->id))->handle(app(VideoUploadService::class), app(ReelsHlsRollout::class));

        $media->refresh();
        $this->assertSame('ready', data_get($media->metadata, 'playback.hls_state'));
        $portrait1080 = collect(data_get($media->metadata, 'playback.renditions', []))->firstWhere('short_edge', 1080);
        $this->assertSame(1080, $portrait1080['width'] ?? null);
        $this->assertSame(1920, $portrait1080['height'] ?? null);
        $signature = data_get($media->metadata, 'playback.hls_source_signature');
        $masterPath = 'uploads/posts/videos/'.$media->id.'/hls/'.$signature.'/master.m3u8';
        $disk->assertExists($masterPath);
        $master = $disk->get($masterPath);
        $this->assertStringContainsString('RESOLUTION=1080x1920', $master);
        $this->assertMatchesRegularExpression('/BANDWIDTH=(\d+),AVERAGE-BANDWIDTH=(\d+),RESOLUTION=1080x1920,FRAME-RATE=\d+\.\d{3},CODECS="avc1\.4d[0-9a-f]{4},mp4a\.40\.2"/', $master);
        preg_match('/BANDWIDTH=(\d+),AVERAGE-BANDWIDTH=(\d+),RESOLUTION=1080x1920/', $master, $bandwidthMatches);
        $this->assertSame((int) $portrait1080['bandwidth'], (int) ($bandwidthMatches[1] ?? 0));
        $this->assertSame((int) $portrait1080['average_bandwidth'], (int) ($bandwidthMatches[2] ?? 0));
        $this->assertGreaterThanOrEqual($portrait1080['average_bandwidth'], $portrait1080['bandwidth']);
        preg_match('/#EXT-X-STREAM-INF:[^\r\n]*RESOLUTION=(\d+x\d+)/', $master, $defaultVariant);
        $this->assertSame('720x1280', $defaultVariant[1] ?? null);
        $variantPath = 'uploads/posts/videos/'.$media->id.'/hls/'.$signature.'/v1080';
        $variantPlaylist = $disk->get($variantPath.'/index.m3u8');
        $this->assertStringContainsString('#EXT-X-INDEPENDENT-SEGMENTS', $variantPlaylist);
        $this->assertStringContainsString('#EXTINF:', $variantPlaylist);
        $segmentPath = $variantPath.'/segment_00000.ts';
        $disk->assertExists($segmentPath);

        $segmentProbe = new \Symfony\Component\Process\Process([
            (new \Symfony\Component\Process\ExecutableFinder())->find('ffprobe'),
            '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'json',
            '-read_intervals', '%+0.2', $disk->path($segmentPath),
        ]);
        $segmentProbe->setTimeout(30)->mustRun();
        $firstFrame = data_get(json_decode($segmentProbe->getOutput(), true), 'frames.0.key_frame');
        $this->assertSame(1, $firstFrame);
        $this->assertSame($sourceSize, $disk->size($originalPath));
    }

    public function test_terminal_encoding_failure_keeps_mp4_ready_and_records_a_retryable_background_failure(): void
    {
        Event::fake();
        Storage::fake('r2_final');
        Storage::disk('r2_final')->put('uploads/posts/source.mp4', 'original mp4');
        config(['media.reels_hls.enabled' => true, 'ffmpeg.ffmpeg_path' => '/missing/ffmpeg']);
        $media = $this->video($this->createPost($this->user()), [
            'provider' => 'r2',
            'playback_state' => 'ready',
            'background_processing_state' => 'queued',
            'background_processing_dispatched_at' => now()->subMinute()->toIso8601String(),
        ]);

        $probe = Mockery::mock(VideoUploadService::class);
        $probe->shouldReceive('getVideoDimensions')->once()->andReturn(['width' => 640, 'height' => 360]);
        $job = new GeneratePostVideoHls((int) $media->id);
        try {
            $job->handle($probe, app(ReelsHlsRollout::class));
            $this->fail('Encoding should fail when FFmpeg is unavailable.');
        } catch (RuntimeException $exception) {
            $job->failed($exception);
        }

        $media->refresh();
        $this->assertSame('ready', data_get($media->metadata, 'playback_state'));
        $this->assertSame('failed', data_get($media->metadata, 'background_processing_state'));
        $this->assertNotEmpty(data_get($media->metadata, 'background_processing_error'));
        $this->assertNull(data_get($media->metadata, 'playback.hls'));
        $this->assertSame('uploads/posts/source.mp4', $media->source_path);
        Storage::disk('r2_final')->assertExists('uploads/posts/source.mp4');
        $this->assertSame([30, 120, 600, 1800], $job->backoff());
    }

    public function test_stale_processing_video_is_requeued_without_changing_its_mp4_source(): void
    {
        Queue::fake();
        Storage::fake('r2_final');
        config(['media.reels_hls.enabled' => true]);
        $media = $this->video($this->createPost($this->user()), [
            'provider' => 'r2',
            'playback_state' => 'ready',
            'background_processing_state' => 'processing',
            'background_processing_updated_at' => now()->subHours(3)->toIso8601String(),
            'background_processing_dispatched_at' => now()->subHours(3)->toIso8601String(),
            'playback' => ['hls' => null, 'hls_state' => 'processing'],
        ]);

        $this->artisan('media:reconcile-reel-hls')->assertSuccessful();

        $media->refresh();
        $this->assertSame('uploads/posts/source.mp4', $media->source_path);
        $this->assertSame('ready', data_get($media->metadata, 'playback_state'));
        $this->assertSame('queued', data_get($media->metadata, 'background_processing_state'));
        Queue::assertPushed(GeneratePostVideoHls::class, fn (GeneratePostVideoHls $job): bool => $job->mediaId === (int) $media->id);
    }

    public function test_rebuild_option_queues_old_hls_outputs_in_bounded_batches(): void
    {
        Queue::fake();
        Storage::fake('r2_final');
        config(['media.reels_hls.enabled' => true]);
        $oldMedia = $this->video($this->createPost($this->user()), [
            'provider' => 'r2',
            'playback' => [
                'hls' => 'https://cdn.example.test/old/master.m3u8',
                'hls_state' => 'ready',
                'renditions' => [['height' => 720, 'state' => 'ready']],
            ],
        ]);
        $newMedia = $this->video($this->createPost($this->user()), [
            'provider' => 'r2',
            'background_processing_state' => 'processed',
            'playback' => [
                'hls_state' => 'ready',
                'encoding_version' => GeneratePostVideoHls::ENCODING_VERSION,
            ],
        ]);

        $this->artisan('media:reconcile-reel-hls', ['--rebuild' => true, '--limit' => 1])
            ->expectsOutput('Requeued 1 reel HLS job(s).')
            ->assertSuccessful();

        $oldMedia->refresh();
        $this->assertSame('queued', data_get($oldMedia->metadata, 'playback.hls_state'));
        $this->assertSame('queued', data_get($oldMedia->metadata, 'background_processing_state'));
        $this->assertSame('ready', data_get($newMedia->fresh()->metadata, 'playback.hls_state'));
        Queue::assertPushedTimes(GeneratePostVideoHls::class, 1);
        Queue::assertPushed(GeneratePostVideoHls::class, fn (GeneratePostVideoHls $job): bool => $job->mediaId === (int) $oldMedia->id);
    }

    public function test_rebuild_recovers_queued_video_rows_with_missing_hls_output(): void
    {
        Queue::fake();
        Storage::fake('r2_final');
        config(['media.reels_hls.enabled' => true]);
        $media = $this->video($this->createPost($this->user()), [
            'background_processing_state' => 'queued',
            'background_processing_updated_at' => now()->subMinutes(20)->toIso8601String(),
            'background_processing_dispatched_at' => now()->subMinutes(20)->toIso8601String(),
            'playback' => ['hls' => null, 'hls_state' => 'unset'],
        ]);

        $this->artisan('media:reconcile-reel-hls', ['--rebuild' => true, '--limit' => 15])
            ->expectsOutput('Requeued 1 reel HLS job(s).')
            ->assertSuccessful();

        $this->assertSame('queued', data_get($media->fresh()->metadata, 'playback.hls_state'));
        Queue::assertPushedTimes(GeneratePostVideoHls::class, 1);
        Queue::assertPushed(GeneratePostVideoHls::class, fn (GeneratePostVideoHls $job): bool => $job->mediaId === (int) $media->id);
    }

    public function test_missing_only_backfill_skips_ready_queued_and_processing_hls_rows(): void
    {
        Queue::fake();
        Storage::fake('r2_final');
        config(['media.reels_hls.enabled' => true]);
        $missing = $this->video($this->createPost($this->user()), [
            'background_processing_state' => 'processed',
            'playback' => ['hls' => null, 'hls_state' => 'unset'],
        ]);
        $failed = $this->video($this->createPost($this->user()), [
            'background_processing_state' => 'failed',
            'playback' => ['hls' => null, 'hls_state' => 'failed'],
        ]);
        $readyOld = $this->video($this->createPost($this->user()), [
            'background_processing_state' => 'processed',
            'playback' => [
                'hls' => 'https://cdn.example.test/old/master.m3u8',
                'hls_state' => 'ready',
                'encoding_version' => 'v1',
            ],
        ]);
        $queued = $this->video($this->createPost($this->user()), [
            'background_processing_state' => 'queued',
            'playback' => ['hls' => null, 'hls_state' => 'queued'],
        ]);
        $processing = $this->video($this->createPost($this->user()), [
            'background_processing_state' => 'processing',
            'playback' => ['hls' => null, 'hls_state' => 'processing'],
        ]);

        $this->artisan('media:reconcile-reel-hls', ['--missing-only' => true, '--limit' => 2])
            ->expectsOutput('Requeued 2 reel HLS job(s).')
            ->assertSuccessful();

        $this->assertSame('queued', data_get($missing->fresh()->metadata, 'playback.hls_state'));
        $this->assertSame('queued', data_get($failed->fresh()->metadata, 'playback.hls_state'));
        $this->assertSame('ready', data_get($readyOld->fresh()->metadata, 'playback.hls_state'));
        $this->assertSame('queued', data_get($queued->fresh()->metadata, 'playback.hls_state'));
        $this->assertSame('processing', data_get($processing->fresh()->metadata, 'playback.hls_state'));
        Queue::assertPushedTimes(GeneratePostVideoHls::class, 2);
        Queue::assertPushed(GeneratePostVideoHls::class, fn (GeneratePostVideoHls $job): bool => $job->mediaId === (int) $missing->id);
        Queue::assertPushed(GeneratePostVideoHls::class, fn (GeneratePostVideoHls $job): bool => $job->mediaId === (int) $failed->id);
    }

    public function test_performance_playback_metrics_discard_identifying_fields(): void
    {
        $logger = Mockery::mock();
        $logger->shouldReceive('info')->once()->with('client_performance_batch', Mockery::on(function (array $context): bool {
            $event = $context['events'][0] ?? [];

            return ($event['metric'] ?? null) === 'media_first_frame'
                && ($event['network'] ?? null) === '3g'
                && ! array_key_exists('user_id', $event)
                && ! array_key_exists('post_id', $event)
                && ! array_key_exists('device_id', $event)
                && ! array_key_exists('media_url', $event);
        }));
        Log::shouldReceive('channel')->once()->with('performance')->andReturn($logger);

        $this->postJson('/api/performance/events', [
            'events' => [[
                'metric' => 'media_first_frame',
                'value' => 935,
                'category' => 'explore',
                'network' => '3g',
                'user_id' => 42,
                'post_id' => 81,
                'device_id' => 'persistent-id',
                'media_url' => 'https://cdn.example.test/private.mp4',
            ]],
        ])->assertNoContent();
    }

    private function resourceFor(Media $media, ?User $viewer): array
    {
        $request = Request::create('/api/timeline', 'GET');
        $request->setUserResolver(fn () => $viewer);

        return (new MediaResource($media))->toArray($request);
    }

    private function video(Post $post, array $metadata = []): Media
    {
        Storage::disk('r2_final')->put('uploads/posts/source.mp4', 'original mp4');

        return $post->media()->create([
            'type' => MediaType::VIDEO,
            'status' => MediaStatus::PROCESSED,
            'source_path' => 'uploads/posts/source.mp4',
            'disk' => 'r2_final',
            'mime' => 'video/mp4',
            'extension' => 'mp4',
            'size' => Storage::disk('r2_final')->size('uploads/posts/source.mp4'),
            'metadata' => array_merge(['provider' => 'r2'], $metadata),
        ]);
    }

    private function createPost(User $user): Post
    {
        return Post::create([
            'user_id' => $user->id,
            'content' => 'Reel test',
            'status' => PostStatus::ACTIVE,
            'type' => PostType::TEXT,
            'text_language' => 'en',
            'comments_count' => 0,
        ]);
    }

    private function user(): User
    {
        $username = 'reel_hls_'.Str::lower(Str::random(10));

        return User::create([
            'first_name' => 'Reel', 'last_name' => 'Tester', 'username' => $username,
            'caption' => '@'.$username, 'email' => $username.'@example.com', 'password' => bcrypt('password'),
            'phone' => '', 'website' => '', 'bio' => '', 'gender' => 'male', 'language' => 'en',
            'last_active' => now()->timestamp, 'tips' => [], 'email_verified_at' => now(),
            'role' => 'user', 'theme' => 'light', 'status' => UserStatus::ACTIVE, 'type' => 'author',
            'publications_count' => 0, 'followers_count' => 0, 'following_count' => 0,
        ]);
    }
}
