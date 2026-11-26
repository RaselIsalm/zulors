<?php

namespace App\Services\Media;

use App\Models\Media;

/**
 * Gradually switches post videos from raw-upload playback to verified MP4
 * playback. The policy is stored on opted-in media so every viewer observes
 * the same readiness state, regardless of who is viewing it.
 */
final class CanonicalVideoPlaybackPolicy
{
    public const MODE = 'canonical_mp4';

    public function enabledForUser(int|string|null $userId): bool
    {
        if ((bool) config('media.video_playback.canonical_ready_globally', false)) {
            return true;
        }

        if ($userId === null || $userId === '') {
            return false;
        }

        return in_array((string) $userId, array_map('strval', (array) config('media.video_playback.canonical_ready_user_ids', [])), true);
    }

    public function applyTo(array $metadata, int|string|null $userId): array
    {
        if ($this->enabledForUser($userId)) {
            $metadata['playback_readiness'] = self::MODE;
        }

        return $metadata;
    }

    public function requiredFor(Media $media): bool
    {
        return data_get($media->metadata, 'playback_readiness') === self::MODE
            || ((bool) config('media.video_playback.canonical_ready_globally', false)
                && data_get($media->metadata, 'provider') === 'r2'
                && data_get($media->metadata, 'upload_state') === 'uploaded');
    }

    public function isReady(Media $media): bool
    {
        return data_get($media->metadata, 'playback_state') === 'ready'
            && data_get($media->metadata, 'processing_mode') === 'optimized_mp4'
            && filled($media->source_path);
    }
}
