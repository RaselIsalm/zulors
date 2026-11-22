<?php

namespace Tests\Feature;

use App\Enums\Media\MediaStatus;
use App\Enums\Media\MediaType;
use App\Models\Media;
use App\Services\Media\Cloudflare\CloudflareStreamService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CloudflareStreamPilotTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config([
            'media.cloudflare.stream.enabled' => true,
            'media.cloudflare.stream.account_id' => 'account-test',
            'media.cloudflare.stream.api_token' => 'token-test',
            'media.cloudflare.stream.webhook_secret' => 'webhook-test',
            'media.cloudflare.stream.customer_subdomain' => 'customer-test.cloudflarestream.com',
            'media.cloudflare.stream.pilot_user_ids' => ['41'],
            'media.cloudflare.stream.stored_minutes_cap' => 1000,
            'media.cloudflare.stream.delivered_minutes_guardrail' => 10,
        ]);
        Cache::flush();
    }

    public function test_r2_import_is_idempotently_addressed_and_reuses_the_r2_signed_url(): void
    {
        Http::fakeSequence()
            ->push(['success' => true, 'result' => []])
            ->push(['success' => true, 'result' => ['totalStorageMinutes' => 120]])
            ->push(['success' => true, 'result' => ['uid' => 'stream-uid-1', 'readyToStream' => false]]);

        $storage = new class
        {
            public function url(string $path): string
            {
                return 'https://media.example.test/'.$path;
            }
        };
        Storage::shouldReceive('disk')->once()->with('r2_final')->andReturn($storage);
        $media = new Media([
            'id' => 123, 'mediaable_id' => 41, 'mediaable_type' => \App\Models\Post::class,
            'source_path' => 'posts/video.mp4', 'disk' => 'r2_final', 'type' => MediaType::VIDEO,
            'status' => MediaStatus::PROCESSED, 'metadata' => ['provider' => 'r2', 'duration_seconds' => 75, 'publication_id' => 'publication-123'],
        ]);
        $media->setAttribute('id', 123);

        $asset = app(CloudflareStreamService::class)->ingestFromR2($media);

        $this->assertSame('stream-uid-1', $asset['uid']);
        Http::assertSent(fn ($request) => str_ends_with($request->url(), '/stream/copy')
            && $request['input'] === 'https://media.example.test/posts/video.mp4'
            && $request['creator'] === 'zulors-media-123'
            && $request['meta']['app_media_id'] === '123'
            && $request['requireSignedURLs'] === false);
    }

    public function test_stream_import_rejects_media_outside_the_canonical_r2_final_disk(): void
    {
        Http::preventStrayRequests();
        $media = new Media([
            'id' => 124, 'source_path' => 'uploads/video.mp4', 'disk' => 'local',
            'type' => MediaType::VIDEO, 'metadata' => ['provider' => 'r2', 'duration_seconds' => 12],
        ]);

        try {
            app(CloudflareStreamService::class)->ingestFromR2($media);
            $this->fail('Non-R2 final media must not be imported into the managed Stream pilot.');
        } catch (\RuntimeException $error) {
            $this->assertSame('Only a stored R2 video can be imported into Stream.', $error->getMessage());
        }
    }

    public function test_canonical_r2_video_is_playable_before_optional_background_processing_finishes(): void
    {
        Storage::shouldReceive('disk')->once()->with('r2_final')->andReturn(new class
        {
            public function url(string $path): string
            {
                return 'https://media.example.test/'.$path;
            }
        });

        $media = new Media([
            'source_path' => 'posts/instant.mp4',
            'disk' => 'r2_final',
            'type' => MediaType::VIDEO,
            'status' => MediaStatus::PROCESSING,
            'metadata' => [
                'provider' => 'r2',
                'final_disk' => 'r2_final',
                'upload_state' => 'uploaded',
                'background_processing_state' => 'queued',
            ],
        ]);

        $this->assertSame('https://media.example.test/posts/instant.mp4', $media->source_url);
    }

    public function test_stream_webhook_requires_fresh_cloudflare_hmac_and_switches_r2_media_only_when_ready(): void
    {
        $media = Media::create([
            'mediaable_id' => 999,
            'mediaable_type' => \App\Models\Post::class,
            'source_path' => 'posts/video.mp4',
            'disk' => 'r2_final',
            'type' => MediaType::VIDEO,
            'status' => MediaStatus::PROCESSED,
            'extension' => 'mp4',
            'mime' => 'video/mp4',
            'size' => 1000,
            'metadata' => [
                'stream' => ['uid' => 'stream-ready-1', 'state' => 'processing'],
                'playback' => ['hls' => 'https://r2.example.test/manifest.m3u8'],
            ],
        ]);
        $payload = ['uid' => 'stream-ready-1', 'readyToStream' => true, 'status' => ['state' => 'ready']];
        $body = json_encode($payload, JSON_THROW_ON_ERROR);
        $timestamp = (string) now()->timestamp;
        $signature = hash_hmac('sha256', $timestamp.'.'.$body, 'webhook-test');

        $this->call('POST', '/api/webhooks/cloudflare/stream', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_WEBHOOK_SIGNATURE' => "time={$timestamp},sig1={$signature}",
        ], $body)->assertOk();

        $media->refresh();
        $this->assertSame('ready', data_get($media->metadata, 'stream.state'));
        $this->assertSame('https://customer-test.cloudflarestream.com/stream-ready-1/manifest/video.m3u8', $media->source_url);
        $this->assertSame('https://r2.example.test/manifest.m3u8', data_get($media->metadata, 'playback.hls'));
    }

    public function test_stream_webhook_rejects_unsigned_or_stale_requests_even_when_secret_is_configured(): void
    {
        $body = json_encode(['uid' => 'ignored', 'readyToStream' => true], JSON_THROW_ON_ERROR);
        $staleTimestamp = (string) now()->subMinutes(10)->timestamp;
        $staleSignature = hash_hmac('sha256', $staleTimestamp.'.'.$body, 'webhook-test');

        $this->call('POST', '/api/webhooks/cloudflare/stream', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_WEBHOOK_SIGNATURE' => "time={$staleTimestamp},sig1={$staleSignature}",
        ], $body)->assertUnauthorized();

        $this->call('POST', '/api/webhooks/cloudflare/stream', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
        ], $body)->assertUnauthorized();
    }

    public function test_delivery_guardrail_uses_monthly_watch_seconds_and_stops_new_ingest_at_95_percent(): void
    {
        $stream = app(CloudflareStreamService::class);
        $this->assertFalse($stream->deliveredBudgetReached());
        for ($index = 0; $index < 4; $index++) $stream->recordDeliveredSeconds(120);
        $this->assertFalse($stream->deliveredBudgetReached());
        $stream->recordDeliveredSeconds(120);
        $this->assertTrue($stream->deliveredBudgetReached());
        $this->assertFalse($stream->managedPlaybackAllowed());
        $this->assertSame(600, (int) \Illuminate\Support\Facades\DB::table('cloudflare_stream_monthly_usage')->value('delivered_seconds'));
    }

    public function test_delivery_guardrail_serializes_ready_media_from_r2_after_the_estimate_reaches_95_percent(): void
    {
        config(['media.cloudflare.stream.delivered_minutes_guardrail' => 1]);
        app(CloudflareStreamService::class)->recordDeliveredSeconds(57);

        $media = new Media([
            'source_path' => 'posts/video.mp4', 'disk' => 'r2_final', 'type' => MediaType::VIDEO,
            'status' => MediaStatus::PROCESSED, 'metadata' => [
                'stream' => ['uid' => 'stream-uid-fallback', 'state' => 'ready'],
                'playback' => ['stream_hls' => 'https://customer.example.test/stream-uid-fallback/manifest/video.m3u8'],
            ],
        ]);

        $this->assertFalse(app(CloudflareStreamService::class)->managedPlaybackAllowed());
        $this->assertSame(storage_url('posts/video.mp4', 'r2_final'), $media->source_url);
    }
}
