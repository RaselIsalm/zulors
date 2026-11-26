<?php

namespace Tests\Unit;

use App\Enums\Media\MediaType;
use App\Models\Media;
use App\Services\Media\CanonicalVideoPlaybackPolicy;
use Tests\TestCase;

class CanonicalVideoPlaybackPolicyTest extends TestCase
{
    public function test_canary_is_selected_by_video_owner_and_global_mode_is_limited_to_uploaded_r2_media(): void
    {
        config([
            'media.video_playback.canonical_ready_globally' => false,
            'media.video_playback.canonical_ready_user_ids' => ['42'],
        ]);
        $policy = app(CanonicalVideoPlaybackPolicy::class);

        $this->assertTrue($policy->enabledForUser(42));
        $this->assertFalse($policy->enabledForUser(43));
        $this->assertSame('canonical_mp4', data_get($policy->applyTo([], 42), 'playback_readiness'));

        config(['media.video_playback.canonical_ready_globally' => true]);
        $directR2 = new Media([
            'type' => MediaType::VIDEO,
            'source_path' => 'video/original.mp4',
            'metadata' => ['provider' => 'r2', 'upload_state' => 'uploaded'],
        ]);
        $otherProvider = new Media([
            'type' => MediaType::VIDEO,
            'source_path' => 'stream/uid',
            'metadata' => ['provider' => 'cloudflare_stream', 'upload_state' => 'uploaded'],
        ]);

        $this->assertTrue($policy->requiredFor($directR2));
        $this->assertFalse($policy->requiredFor($otherProvider));
    }

    public function test_playback_is_ready_only_for_a_ready_optimized_mp4(): void
    {
        $policy = app(CanonicalVideoPlaybackPolicy::class);
        $media = new Media([
            'type' => MediaType::VIDEO,
            'source_path' => 'video/original.mp4',
            'metadata' => ['playback_state' => 'processing', 'processing_mode' => 'original_direct'],
        ]);

        $this->assertFalse($policy->isReady($media));
        $media->metadata = ['playback_state' => 'ready', 'processing_mode' => 'optimized_mp4'];
        $this->assertTrue($policy->isReady($media));
    }
}
