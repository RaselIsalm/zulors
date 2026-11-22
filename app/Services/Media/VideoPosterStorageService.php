<?php

namespace App\Services\Media;

use Illuminate\Support\Facades\Storage;

class VideoPosterStorageService
{
    public function store(?string $dataUrl, string $disk, string $directory, array $context = []): ?array
    {
        if (! $dataUrl || ! preg_match('~\Adata:image/jpeg;base64,([A-Za-z0-9+/=]+)\z~', $dataUrl, $matches)) {
            return null;
        }

        $bytes = base64_decode($matches[1], true);
        if (! is_string($bytes) || strlen($bytes) < 4 || strlen($bytes) > 72_000
            || ! str_starts_with($bytes, "\xFF\xD8\xFF")) {
            return null;
        }

        $image = function_exists('getimagesizefromstring') ? @getimagesizefromstring($bytes) : false;
        if (! is_array($image) || ($image['mime'] ?? null) !== 'image/jpeg'
            || (int) ($image[0] ?? 0) < 1 || (int) ($image[1] ?? 0) < 1
            || (int) ($image[0] ?? 0) > 640 || (int) ($image[1] ?? 0) > 640) {
            return null;
        }

        $path = trim($directory, '/').'/poster.jpg';
        try {
            if (! Storage::disk($disk)->put($path, $bytes, [
                'ContentType' => 'image/jpeg',
                'CacheControl' => config('media.cache.control'),
            ])) {
                return null;
            }

            return [
                'thumbnail_path' => $path,
                'thumbnail_disk' => $disk,
                'thumbnail_size' => strlen($bytes),
            ];
        } catch (\Throwable $error) {
            logger()->warning('media.video.poster_store_failed', $context + ['exception' => $error::class]);

            return null;
        }
    }
}
