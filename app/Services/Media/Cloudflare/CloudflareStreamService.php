<?php

namespace App\Services\Media\Cloudflare;

use App\Models\Media;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

class CloudflareStreamService
{
    private const API_BASE = 'https://api.cloudflare.com/client/v4';

    public function playbackUrls(?string $uid): array
    {
        if (empty($uid)) {
            return [];
        }

        $customerSubdomain = trim((string) config('media.cloudflare.stream.customer_subdomain'));
        $baseUrl = $customerSubdomain !== ''
            ? 'https://'.rtrim(preg_replace('~^https?://~i', '', $customerSubdomain), '/').'/'.$uid
            : 'https://videodelivery.net/'.$uid;

        return [
            'hls' => "{$baseUrl}/manifest/video.m3u8",
            'dash' => "{$baseUrl}/manifest/video.mpd",
            'thumbnail' => "{$baseUrl}/thumbnails/thumbnail.jpg",
            'watch' => $baseUrl,
        ];
    }

    public function isConfigured(): bool
    {
        return (bool) config('media.cloudflare.stream.enabled')
            && filled(config('media.cloudflare.stream.account_id'))
            && filled(config('media.cloudflare.stream.api_token'))
            && filled(config('media.cloudflare.stream.webhook_secret'));
    }

    public function isPilotUser(mixed $userId): bool
    {
        $allowed = array_map('strval', config('media.cloudflare.stream.pilot_user_ids', []));

        return $this->isConfigured() && filled($userId) && in_array((string) $userId, $allowed, true);
    }

    /**
     * Import an R2 playback object into Stream. A creator ID derived from the
     * media row makes queue retries recover the same Stream asset instead of
     * creating another billable copy.
     */
    public function ingestFromR2(Media $media): array
    {
        if (! $this->isConfigured()) {
            throw new RuntimeException('Cloudflare Stream pilot is not configured.');
        }

        if (! $media->type?->isVideo()
            || $media->disk !== (string) config('media.cloudflare.r2.final_disk', 'r2_final')
            || data_get($media->metadata, 'provider') !== 'r2'
            || blank($media->source_path)) {
            throw new RuntimeException('Only a stored R2 video can be imported into Stream.');
        }

        $creator = 'zulors-media-'.$media->getKey();
        $existing = $this->findByCreator($creator, (string) $media->getKey());
        if ($existing) {
            return $existing;
        }

        $minutes = max(1, (int) ceil((float) data_get($media->metadata, 'duration_seconds', 0) / 60));
        $this->assertStoredMinuteBudget($minutes, (string) $media->getKey());

        try {
            // Stream's URL importer performs HEAD and range GET requests. The
            // final R2 disk is already published through the app's cached media
            // domain, which supports those methods; a presigned GET URL would
            // not reliably authorize the importer’s HEAD request.
            $sourceUrl = Storage::disk($media->disk)->url($media->source_path);
        } catch (\Throwable $error) {
            throw new RuntimeException('The R2 playback object URL could not be built for Stream import.', previous: $error);
        }

        if (! str_starts_with($sourceUrl, 'https://')) {
            throw new RuntimeException('Cloudflare Stream requires a publicly reachable HTTPS R2 URL.');
        }

        $publicationId = data_get($media->metadata, 'publication_id');
        $response = $this->api()->post($this->endpoint('/stream/copy'), [
            'input' => $sourceUrl,
            'creator' => $creator,
            'name' => 'zulors-media-'.$media->getKey(),
            'meta' => [
                'name' => 'zulors-media-'.$media->getKey(),
                'app_media_id' => (string) $media->getKey(),
                'publication_id' => $publicationId ? (string) $publicationId : '',
            ],
            'allowedOrigins' => array_values(config('media.cloudflare.stream.allowed_origins', [])),
            'requireSignedURLs' => false,
        ]);

        if (! $response->successful() || ! $response->json('success')) {
            throw new RuntimeException('Cloudflare Stream rejected the R2 import request.');
        }

        $asset = $response->json('result', []);
        if (blank(data_get($asset, 'uid'))) {
            throw new RuntimeException('Cloudflare Stream did not return an asset identifier.');
        }

        return $asset;
    }

    public function storedMinutes(): float
    {
        $response = $this->api()->get($this->endpoint('/stream/storage-usage'));
        if (! $response->successful() || ! $response->json('success')) {
            throw new RuntimeException('Cloudflare Stream storage usage could not be checked.');
        }

        return max(0, (float) $response->json('result.totalStorageMinutes', 0));
    }

    public function assertStoredMinuteBudget(int $incomingMinutes, string $mediaId): void
    {
        $period = now()->format('Y-m');
        $key = 'media:cloudflare-stream:stored-minutes:'.$period;
        $reservation = Cache::get($key);
        if (! is_array($reservation) || ! array_key_exists('baseline', $reservation)) {
            $reservation = ['baseline' => $this->storedMinutes(), 'reserved' => 0, 'media_ids' => []];
        }

        $reservation['media_ids'] = (array) ($reservation['media_ids'] ?? []);
        if (in_array($mediaId, $reservation['media_ids'], true)) {
            return;
        }

        $cap = max(1, (int) config('media.cloudflare.stream.stored_minutes_cap', 1000));
        if ((float) $reservation['baseline'] + (int) ($reservation['reserved'] ?? 0) + $incomingMinutes > $cap) {
            Cache::put($key, $reservation, now()->addDays(45));
            throw new RuntimeException('Cloudflare Stream pilot storage-minute cap reached. R2 playback remains active.');
        }

        // Reserve before the external POST. On an ambiguous network failure the
        // reservation intentionally stays in place for this month.
        $reservation['reserved'] = (int) ($reservation['reserved'] ?? 0) + $incomingMinutes;
        $reservation['media_ids'][] = $mediaId;
        Cache::put($key, $reservation, now()->addDays(45));
    }

    public function deliveredBudgetReached(): bool
    {
        $capMinutes = max(1, (int) config('media.cloudflare.stream.delivered_minutes_guardrail', 20000));
        $period = now()->format('Y-m');
        $row = DB::table('cloudflare_stream_monthly_usage')->where('period', $period)->first();
        $deliveredSeconds = max(0, (int) ($row->delivered_seconds ?? 0));
        $guardrail = $capMinutes * 60;

        if ($deliveredSeconds >= (int) floor($guardrail * 0.8)) {
            $warnKey = 'media:cloudflare-stream:delivery-warning:'.$period;
            if (Cache::add($warnKey, true, now()->addDays(45))) {
                logger()->warning('media.cloudflare_stream.delivery_budget_warning', [
                    'period' => $period,
                    'estimated_delivered_minutes' => round($deliveredSeconds / 60, 1),
                    'guardrail_minutes' => $capMinutes,
                    'measurement' => 'application_watch_telemetry_estimate',
                ]);
            }
        }

        return $deliveredSeconds >= (int) floor($guardrail * 0.95);
    }

    public function managedPlaybackAllowed(): bool
    {
        $period = now()->format('Y-m');
        $key = 'media:cloudflare-stream:playback-allowed:'.$period;

        return (bool) Cache::remember($key, now()->addSeconds(15), fn (): bool =>
            $this->isConfigured() && ! $this->deliveredBudgetReached()
        );
    }

    public function recordDeliveredSeconds(float $seconds): void
    {
        $seconds = (int) floor(min(120, max(0, $seconds)));
        if ($seconds < 1) {
            return;
        }

        $period = now()->format('Y-m');
        DB::table('cloudflare_stream_monthly_usage')->insertOrIgnore([
            'period' => $period,
            'delivered_seconds' => 0,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        DB::table('cloudflare_stream_monthly_usage')->where('period', $period)->increment('delivered_seconds', $seconds, ['updated_at' => now()]);
        Cache::forget('media:cloudflare-stream:playback-allowed:'.$period);
    }

    public function deleteVideo(string $uid): void
    {
        if (! filled(config('media.cloudflare.stream.account_id'))
            || ! filled(config('media.cloudflare.stream.api_token')) || blank($uid)) {
            return;
        }

        $response = $this->api()->delete($this->endpoint('/stream/'.rawurlencode($uid)));
        if (! $response->successful() && $response->status() !== 404) {
            throw new RuntimeException('Cloudflare Stream asset deletion failed.');
        }
    }

    private function findByCreator(string $creator, string $mediaId): ?array
    {
        $response = $this->api()->get($this->endpoint('/stream'), ['creator' => $creator, 'limit' => 10]);
        if (! $response->successful() || ! $response->json('success')) {
            throw new RuntimeException('Cloudflare Stream could not check for a previous import.');
        }

        foreach ((array) $response->json('result', []) as $asset) {
            if ((string) data_get($asset, 'creator') === $creator
                && (string) data_get($asset, 'meta.app_media_id') === $mediaId
                && filled(data_get($asset, 'uid'))) {
                return $asset;
            }
        }

        return null;
    }

    private function api()
    {
        return Http::acceptJson()
            ->withToken((string) config('media.cloudflare.stream.api_token'))
            ->timeout(30);
    }

    private function endpoint(string $path): string
    {
        return self::API_BASE.'/accounts/'.rawurlencode((string) config('media.cloudflare.stream.account_id')).$path;
    }
}
