<?php

namespace App\Jobs\User\Timeline;

use App\Enums\Media\MediaStatus;
use App\Enums\Media\MediaType;
use App\Events\User\Timeline\MediaUpdatedEvent;
use App\Models\Media;
use App\Models\Post;
use App\Models\StoryFrame;
use App\Services\Filesystem\Upload\VideoUploadService;
use App\Services\Media\ReelsHlsRollout;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;
use Throwable;

class GeneratePostVideoHls implements ShouldBeUnique, ShouldQueue
{
    use Queueable;

    public const ENCODING_VERSION = 'v6';
    public const SEGMENT_DURATION_SECONDS = 2;
    private const HD_SHORT_EDGE = 720;
    private const HD_SOURCE_TOLERANCE = 0.01;

    public int $tries = 5;
    public int $timeout = 21600;
    // Keep this shorter than the stale-job threshold so a recovered dispatch can acquire the unique lock.
    public int $uniqueFor = 5400;

    private const LADDER = [
        240 => ['video' => 500000, 'max' => 650000],
        360 => ['video' => 950000, 'max' => 1200000],
        480 => ['video' => 1700000, 'max' => 2100000],
        720 => ['video' => 3400000, 'max' => 4000000],
        1080 => ['video' => 6200000, 'max' => 7200000],
    ];

    public static function renditionShortEdgesForSource(int $sourceWidth, int $sourceHeight): array
    {
        $sourceShortEdge = min($sourceWidth, $sourceHeight);
        $minimumHdSourceShortEdge = (int) ceil(self::HD_SHORT_EDGE * (1 - self::HD_SOURCE_TOLERANCE));

        return array_values(array_filter(
            array_keys(self::LADDER),
            static fn (int $shortEdge): bool => $shortEdge <= $sourceShortEdge
                || ($shortEdge === self::HD_SHORT_EDGE && $sourceShortEdge >= $minimumHdSourceShortEdge)
        ));
    }

    public static function renditionDimensions(int $sourceWidth, int $sourceHeight, int $shortEdge): array
    {
        $sourceShortEdge = min($sourceWidth, $sourceHeight);
        $scale = min(1, $shortEdge / max(1, $sourceShortEdge));
        $minimumHdSourceShortEdge = (int) ceil(self::HD_SHORT_EDGE * (1 - self::HD_SOURCE_TOLERANCE));

        if ($shortEdge === self::HD_SHORT_EDGE && $sourceShortEdge >= $minimumHdSourceShortEdge) {
            $scale = $shortEdge / $sourceShortEdge;
        }

        return [
            'width' => max(2, 2 * (int) round(($sourceWidth * $scale) / 2)),
            'height' => max(2, 2 * (int) round(($sourceHeight * $scale) / 2)),
        ];
    }

    public static function renditionProfile(int $shortEdge): array
    {
        return self::LADDER[$shortEdge] ?? [];
    }

    public function __construct(public readonly int $mediaId)
    {
        $this->onConnection(config('media.queue_connection'));
        $this->onQueue(config('media.queues.video'));
        $this->timeout = max(1800, (int) config('media.reels_hls.timeout_seconds', 21600));
    }

    public function uniqueId(): string
    {
        return 'post-video-hls:'.$this->mediaId;
    }

    public function backoff(): array
    {
        return [30, 120, 600, 1800];
    }

    public function handle(VideoUploadService $videoUploadService, ReelsHlsRollout $rollout): void
    {
        $media = Media::query()->with('mediaable')->find($this->mediaId);

        $isPost = $media?->mediaable instanceof Post;
        $isStory = $media?->mediaable instanceof StoryFrame;
        $enabled = $isPost
            ? $rollout->processingEnabled()
            : ($isStory && (bool) config('media.stories_hls.enabled', false));

        if (! $media || ! $media->type->isVideo() || ! $media->status->isProcessed()
            || (! $isPost && ! $isStory) || ! $enabled
            || data_get($media->metadata, 'provider') !== 'r2') {
            return;
        }

        $metadata = $media->metadata ?? [];
        $source = $this->sourceDescriptor($media);
        $sourceSignature = $this->sourceSignature($media);
        $attempt = (int) data_get($metadata, 'background_processing_attempts', 0) + 1;

        if (data_get($metadata, 'playback.hls_state') === 'ready'
            && data_get($metadata, 'playback.hls_source_signature') === $sourceSignature) {
            return;
        }

        $startedAt = microtime(true);
        $queueAgeSeconds = $this->queueAgeSeconds($metadata);
        $workDirectory = storage_path('app/tmp/reel-hls/'.$media->id.'-'.bin2hex(random_bytes(5)));
        $sourcePath = $workDirectory.'/source.'.($this->safeExtension($source['extension']) ?: 'mp4');
        $mediaPrefix = $isStory ? 'uploads/stories/videos' : 'uploads/posts/videos';
        $outputPrefix = $mediaPrefix.'/'.$media->id.'/hls/'.$sourceSignature;
        @mkdir($workDirectory, 0775, true);
        $failureStage = 'initialize';

        try {
            $this->updateMetadata($media, function (array $next) use ($sourceSignature, $attempt, $outputPrefix): array {
                $next['playback_state'] = 'ready';
                $next['background_processing_state'] = 'processing';
                $next['background_processing_progress'] = 1;
                $next['background_processing_updated_at'] = now()->toIso8601String();
                $next['background_processing_attempts'] = $attempt;
                $next['playback'] = array_merge((array) ($next['playback'] ?? []), [
                    'hls' => null,
                    'hls_state' => 'processing',
                    'hls_prefix' => $outputPrefix,
                    'hls_source_signature' => $sourceSignature,
                    'renditions' => [],
                ]);

                return $next;
            });

            Log::channel('performance')->info('reel_hls_job_started', [
                'queue_age_seconds' => $queueAgeSeconds,
            ]);

            $failureStage = 'source_download';
            $downloadStartedAt = microtime(true);
            $this->downloadSource($source, $sourcePath, function (int $downloadedBytes, int $totalBytes) use ($media): void {
                static $lastHeartbeat = 0;
                $now = time();
                if ($downloadedBytes < $totalBytes && $now - $lastHeartbeat < 15) {
                    return;
                }
                $lastHeartbeat = $now;
                $progress = $totalBytes > 0 ? min(5, 1 + (int) floor(4 * $downloadedBytes / $totalBytes)) : 1;
                $this->updateMetadata($media, static function (array $next) use ($progress): array {
                    $next['background_processing_state'] = 'processing';
                    $next['background_processing_progress'] = max((int) ($next['background_processing_progress'] ?? 0), $progress);
                    $next['background_processing_updated_at'] = now()->toIso8601String();
                    $next['playback_state'] = 'ready';
                    $next['playback'] = array_merge((array) ($next['playback'] ?? []), ['hls' => null, 'hls_state' => 'processing']);

                    return $next;
                }, false);
            });
            Log::channel('performance')->info('reel_hls_source_download_completed', [
                'download_duration_seconds' => round(microtime(true) - $downloadStartedAt, 3),
                'source_bytes' => (int) ($source['size'] ?? 0),
            ]);
            $failureStage = 'inspect_source';
            $dimensions = $videoUploadService->getVideoDimensions($sourcePath);
            $sourceHeight = (int) ($dimensions['height'] ?? 0);
            $sourceWidth = (int) ($dimensions['width'] ?? 0);
            $targets = self::renditionShortEdgesForSource($sourceWidth, $sourceHeight);

            if (! $targets || min($sourceWidth, $sourceHeight) < 240 || $sourceWidth < 2 || $sourceHeight < 2) {
                $this->markSkipped($media, $sourceSignature, $dimensions);

                return;
            }

            $ffmpeg = $this->ffmpegBinary();
            $renditions = [];
            $playlistEntries = [];
            $diskName = (string) $media->disk;
            $outputDisk = Storage::disk($diskName);
            $progressBase = 5;
            $progressPerRendition = (int) floor(75 / count($targets));

            foreach ($targets as $shortEdge) {
                $shortEdge = (int) $shortEdge;
                $profile = self::LADDER[$shortEdge];
                $renditionDimensions = self::renditionDimensions($sourceWidth, $sourceHeight, $shortEdge);
                $renditionWidth = $renditionDimensions['width'];
                $renditionHeight = $renditionDimensions['height'];
                $renditionDirectory = $workDirectory.'/v'.$shortEdge;
                @mkdir($renditionDirectory, 0775, true);
                $playlistPath = $renditionDirectory.'/index.m3u8';

                $failureStage = 'encode_rendition_'.$shortEdge;
                $encodeStartedAt = microtime(true);
                Log::channel('performance')->info('reel_hls_rendition_encode_started', [
                    'short_edge' => $shortEdge,
                ]);
                $this->runRendition($ffmpeg, $sourcePath, $playlistPath, $profile, $renditionWidth, $renditionHeight, $workDirectory, $media);
                $measuredBandwidth = $this->measureRenditionBandwidth($playlistPath);
                $manifestAttributes = $this->renditionManifestAttributes($videoUploadService, $playlistPath);
                Log::channel('performance')->info('reel_hls_rendition_encode_completed', [
                    'short_edge' => $shortEdge,
                    'bandwidth' => $measuredBandwidth['peak'],
                    'average_bandwidth' => $measuredBandwidth['average'],
                    'frame_rate' => $manifestAttributes['frame_rate'],
                    'duration_seconds' => round(microtime(true) - $encodeStartedAt, 3),
                    'segments' => count(glob($renditionDirectory.'/segment_*.ts') ?: []),
                ]);

                $failureStage = 'upload_rendition_'.$shortEdge;
                $this->uploadDirectory($outputDisk, $renditionDirectory, $outputPrefix.'/v'.$shortEdge, $media, $shortEdge);

                $renditions[] = [
                    'short_edge' => $shortEdge,
                    'quality' => $shortEdge.'p',
                    'height' => $renditionHeight,
                    'width' => $renditionWidth,
                    'state' => 'ready',
                    'bandwidth' => $measuredBandwidth['peak'],
                    'average_bandwidth' => $measuredBandwidth['average'],
                    'frame_rate' => $manifestAttributes['frame_rate'],
                ];
                $playlistEntries[] = [
                    'short_edge' => $shortEdge,
                    'playlist' => "#EXT-X-STREAM-INF:BANDWIDTH={$measuredBandwidth['peak']},AVERAGE-BANDWIDTH={$measuredBandwidth['average']},RESOLUTION={$renditionWidth}x{$renditionHeight},FRAME-RATE={$manifestAttributes['frame_rate']},CODECS=\"{$manifestAttributes['codecs']}\"\nv{$shortEdge}/index.m3u8",
                ];

                $progressBase += $progressPerRendition;
                $this->updateMetadata($media, function (array $next) use ($progressBase, $renditions, $sourceSignature): array {
                    $next['background_processing_progress'] = min(95, $progressBase);
                    $next['background_processing_updated_at'] = now()->toIso8601String();
                    $next['playback'] = array_merge((array) ($next['playback'] ?? []), [
                        'hls' => null,
                        'hls_state' => 'processing',
                        'hls_source_signature' => $sourceSignature,
                        'renditions' => $renditions,
                    ]);

                    return $next;
                });
            }

            $masterPath = $workDirectory.'/master.m3u8';
            $defaultShortEdge = min(720, max(array_column($playlistEntries, 'short_edge')));
            usort($playlistEntries, static function (array $left, array $right) use ($defaultShortEdge): int {
                if ($left['short_edge'] === $right['short_edge']) {
                    return 0;
                }
                if ($left['short_edge'] === $defaultShortEdge) {
                    return -1;
                }
                if ($right['short_edge'] === $defaultShortEdge) {
                    return 1;
                }

                return $left['short_edge'] <=> $right['short_edge'];
            });
            $masterPlaylists = array_column($playlistEntries, 'playlist');
            file_put_contents($masterPath, "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n".implode("\n", $masterPlaylists)."\n");
            $failureStage = 'upload_master_playlist';
            $this->putFile($outputDisk, $outputPrefix.'/master.m3u8', $masterPath, 'application/vnd.apple.mpegurl');

            $this->updateMetadata($media, function (array $next) use ($diskName, $outputPrefix, $renditions, $sourceSignature, $dimensions): array {
                $next['playback_state'] = 'ready';
                $next['background_processing_state'] = 'processed';
                $next['background_processing_progress'] = 100;
                $next['background_processing_updated_at'] = now()->toIso8601String();
                $next['background_processing_error'] = null;
                $next['playback'] = array_merge((array) ($next['playback'] ?? []), [
                    'hls' => storage_url($outputPrefix.'/master.m3u8', $diskName),
                    'hls_state' => 'ready',
                    'hls_prefix' => $outputPrefix,
                    'hls_source_signature' => $sourceSignature,
                    'encoding_version' => self::ENCODING_VERSION,
                    'source_dimensions' => [
                        'width' => (int) ($dimensions['width'] ?? 0),
                        'height' => (int) ($dimensions['height'] ?? 0),
                    ],
                    'renditions' => $renditions,
                ]);

                return $next;
            });

            Log::channel('performance')->info('reel_hls_job_completed', [
                'queue_age_seconds' => $queueAgeSeconds,
                'encoding_duration_seconds' => round(microtime(true) - $startedAt, 3),
                'rendition_count' => count($renditions),
                'outcome' => 'ready',
            ]);
        } catch (Throwable $exception) {
            Log::channel('performance')->warning('Reel HLS generation attempt failed.', [
                'media_id' => $media->id,
                'stage' => $failureStage,
                'exception' => $exception::class,
            ]);

            throw $exception;
        } finally {
            $this->removeDirectory($workDirectory);
        }
    }

    public function failed(Throwable $exception): void
    {
        $media = Media::query()->with('mediaable')->find($this->mediaId);

        if (! $media) {
            return;
        }

        $this->updateMetadata($media, static function (array $metadata) use ($exception): array {
            $metadata['playback_state'] = 'ready';
            $metadata['background_processing_state'] = 'failed';
            $metadata['background_processing_updated_at'] = now()->toIso8601String();
            $metadata['background_processing_error'] = 'HLS rendition generation failed.';
            $metadata['playback'] = array_merge((array) ($metadata['playback'] ?? []), [
                'hls' => null,
                'hls_state' => 'failed',
            ]);

            return $metadata;
        });

        Log::channel('performance')->warning('reel_hls_job_failed', [
            'outcome' => 'failed',
            'exception' => $exception::class,
        ]);
    }

    private function runRendition(string $ffmpeg, string $sourcePath, string $playlistPath, array $profile, int $width, int $height, string $workingDirectory, Media $media): void
    {
        $segmentPattern = dirname($playlistPath).'/segment_%05d.ts';
        $command = [
            $ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', $sourcePath,
            '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', 'scale='.$width.':'.$height.':flags=lanczos',
            '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'main',
            '-pix_fmt', 'yuv420p', '-b:v', (string) $profile['video'], '-maxrate', (string) $profile['max'],
            '-bufsize', (string) ($profile['max'] * 2), '-g', '240', '-keyint_min', '1', '-sc_threshold', '0',
            '-force_key_frames', 'expr:gte(t,n_forced*'.self::SEGMENT_DURATION_SECONDS.')',
            '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
            '-progress', 'pipe:1', '-nostats', '-f', 'hls', '-hls_time', (string) self::SEGMENT_DURATION_SECONDS, '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts',
            '-hls_flags', 'independent_segments', '-hls_segment_filename', $segmentPattern, $playlistPath,
        ];

        $process = new Process($command, $workingDirectory);
        $process->setTimeout((float) config('media.reels_hls.timeout_seconds', 21600));
        $lastHeartbeat = time();
        $process->mustRun(function (string $type, string $buffer) use ($media, &$lastHeartbeat): void {
            if ($type === Process::OUT && time() - $lastHeartbeat >= 60) {
                $lastHeartbeat = time();
                $this->updateMetadata($media, static function (array $metadata): array {
                    $metadata['background_processing_updated_at'] = now()->toIso8601String();

                    return $metadata;
                }, false);
            }
        });

        if (! is_file($playlistPath) || ! str_contains((string) file_get_contents($playlistPath), '#EXTINF:')) {
            throw new RuntimeException('FFmpeg did not produce a playable HLS rendition.');
        }
    }

    private function sourceDescriptor(Media $media): array
    {
        $original = (array) data_get($media->metadata, 'original_storage', []);
        $originalDisk = (string) ($original['disk'] ?? '');
        $originalPath = (string) ($original['path'] ?? '');
        $useOriginal = $originalDisk !== '' && $originalPath !== '';

        if ($useOriginal) {
            try {
                $useOriginal = Storage::disk($originalDisk)->exists($originalPath);
            } catch (Throwable) {
                $useOriginal = false;
            }
        }

        $usePlaybackFallback = ! $useOriginal && (blank($media->source_path) || blank($media->disk));

        return [
            'disk' => (string) ($useOriginal ? $originalDisk : ($usePlaybackFallback ? ($original['disk'] ?? $media->disk) : $media->disk)),
            'path' => (string) ($useOriginal ? $originalPath : ($usePlaybackFallback ? ($original['path'] ?? $media->source_path) : $media->source_path)),
            'size' => (int) ($useOriginal ? ($original['size'] ?? $media->size) : ($usePlaybackFallback ? ($original['size'] ?? $media->size) : $media->size)),
            'mime' => (string) ($useOriginal ? ($original['mime'] ?? $media->mime) : ($usePlaybackFallback ? ($original['mime'] ?? $media->mime) : $media->mime)),
            'extension' => (string) ($useOriginal ? ($original['extension'] ?? $media->extension) : ($usePlaybackFallback ? ($original['extension'] ?? $media->extension) : $media->extension)),
        ];
    }

    private function downloadSource(array $source, string $destination, ?callable $onProgress = null): void
    {
        $stream = Storage::disk($source['disk'])->readStream($source['path']);

        if (! is_resource($stream)) {
            throw new RuntimeException('Unable to read the playback-ready video source.');
        }

        try {
            @stream_set_timeout($stream, 60);
            $target = fopen($destination, 'wb');
            if (! is_resource($target)) {
                throw new RuntimeException('Unable to create a temporary HLS source file.');
            }
            $downloadedBytes = 0;
            $totalBytes = (int) ($source['size'] ?? 0);
            $lastProgressAt = time();

            try {
                while (! feof($stream)) {
                    $chunk = fread($stream, 1024 * 1024);
                    if ($chunk === false) {
                        throw new RuntimeException('Unable to read the playback-ready video source.');
                    }
                    if ($chunk === '') {
                        $streamStatus = stream_get_meta_data($stream);
                        if (! empty($streamStatus['timed_out'])) {
                            throw new RuntimeException('Timed out while downloading the playback-ready video source.');
                        }
                        if (! feof($stream)) {
                            continue;
                        }
                        break;
                    }

                    $writtenBytes = fwrite($target, $chunk);
                    if ($writtenBytes !== strlen($chunk)) {
                        throw new RuntimeException('Unable to write the complete temporary HLS source file.');
                    }

                    $downloadedBytes += $writtenBytes;
                    if ($onProgress && (time() - $lastProgressAt >= 15 || ($totalBytes > 0 && $downloadedBytes >= $totalBytes))) {
                        $onProgress($downloadedBytes, $totalBytes);
                        $lastProgressAt = time();
                    }
                }
            } finally {
                fclose($target);
            }

            if ($totalBytes > 0 && $downloadedBytes !== $totalBytes) {
                throw new RuntimeException('Downloaded HLS source size does not match the stored media size.');
            }
        } finally {
            fclose($stream);
        }
    }

    private function uploadDirectory($disk, string $localDirectory, string $remoteDirectory, Media $media, int $shortEdge): void
    {
        $files = glob($localDirectory.'/*') ?: [];
        sort($files);
        $startedAt = microtime(true);
        $lastHeartbeatAt = time();
        $uploadedBytes = 0;
        $uploadedFiles = 0;

        foreach ($files as $file) {
            if (! is_file($file)) {
                continue;
            }

            $contentType = str_ends_with($file, '.m3u8')
                ? 'application/vnd.apple.mpegurl'
                : 'video/mp2t';
            $this->putFile($disk, $remoteDirectory.'/'.basename($file), $file, $contentType);
            $uploadedFiles++;
            $uploadedBytes += (int) (filesize($file) ?: 0);

            if (time() - $lastHeartbeatAt >= 30) {
                $this->updateMetadata($media, static function (array $metadata): array {
                    $metadata['background_processing_updated_at'] = now()->toIso8601String();

                    return $metadata;
                }, false);
                $lastHeartbeatAt = time();
            }
        }

        Log::channel('performance')->info('reel_hls_rendition_upload_completed', [
            'short_edge' => $shortEdge,
            'file_count' => $uploadedFiles,
            'bytes' => $uploadedBytes,
            'duration_seconds' => round(microtime(true) - $startedAt, 3),
        ]);
    }

    private function measureRenditionBandwidth(string $playlistPath): array
    {
        $playlist = file_get_contents($playlistPath);
        if ($playlist === false) {
            throw new RuntimeException('Unable to read the encoded HLS rendition playlist.');
        }

        $targetDuration = 4.0;
        $nextSegmentDuration = null;
        $segments = [];

        foreach (preg_split('/\r?\n/', $playlist) ?: [] as $line) {
            $line = trim($line);

            if (preg_match('/^#EXT-X-TARGETDURATION:(\d+)/', $line, $matches)) {
                $targetDuration = max(1.0, (float) $matches[1]);
                continue;
            }

            if (preg_match('/^#EXTINF:([0-9]+(?:\.[0-9]+)?)/', $line, $matches)) {
                $nextSegmentDuration = (float) $matches[1];
                continue;
            }

            if ($nextSegmentDuration === null || $line === '' || str_starts_with($line, '#')) {
                continue;
            }

            $segmentPath = dirname($playlistPath).'/'.$line;
            $segmentBytes = filesize($segmentPath);
            if ($segmentBytes === false || $nextSegmentDuration <= 0) {
                throw new RuntimeException('Unable to measure an encoded HLS segment.');
            }

            $segments[] = [
                'bytes' => $segmentBytes,
                'duration' => $nextSegmentDuration,
            ];
            $nextSegmentDuration = null;
        }

        if ($segments === []) {
            throw new RuntimeException('The encoded HLS rendition contains no measurable segments.');
        }

        $totalBytes = array_sum(array_column($segments, 'bytes'));
        $totalDuration = array_sum(array_column($segments, 'duration'));
        $averageBandwidth = (int) ceil(($totalBytes * 8) / max(0.001, $totalDuration));
        $minimumPeakWindow = $targetDuration * 0.5;
        $maximumPeakWindow = $targetDuration * 1.5;
        $peakBandwidth = 0.0;

        foreach ($segments as $start => $segment) {
            $windowBytes = 0;
            $windowDuration = 0.0;

            for ($index = $start; $index < count($segments); $index++) {
                $next = $segments[$index];
                if ($windowDuration + $next['duration'] > $maximumPeakWindow) {
                    break;
                }

                $windowBytes += $next['bytes'];
                $windowDuration += $next['duration'];

                if ($windowDuration >= $minimumPeakWindow) {
                    $peakBandwidth = max($peakBandwidth, ($windowBytes * 8) / $windowDuration);
                }
            }
        }

        $measuredPeakBandwidth = $peakBandwidth > 0 ? $peakBandwidth : (float) $averageBandwidth;

        return [
            'peak' => (int) ceil($measuredPeakBandwidth * 1.05),
            'average' => $averageBandwidth,
        ];
    }

    private function renditionManifestAttributes(VideoUploadService $videoUploadService, string $playlistPath): array
    {
        $segments = glob(dirname($playlistPath).'/segment_*.ts') ?: [];
        sort($segments);
        $segmentPath = $segments[0] ?? null;
        if (! $segmentPath) {
            throw new RuntimeException('The encoded HLS rendition contains no segments to inspect.');
        }

        $streams = $videoUploadService->getFFProbe()->streams($segmentPath);
        $videoStream = $streams->videos()->first();
        if (! $videoStream || $videoStream->get('codec_name') !== 'h264') {
            throw new RuntimeException('The encoded HLS rendition does not contain an H.264 video stream.');
        }

        $profile = strtolower((string) $videoStream->get('profile'));
        $codecProfile = match (true) {
            str_contains($profile, 'baseline') => '42E0',
            str_contains($profile, 'main') => '4D40',
            str_contains($profile, 'high') => '6400',
            default => throw new RuntimeException('The encoded HLS rendition has an unsupported H.264 profile.'),
        };
        $level = (int) $videoStream->get('level');
        if ($level < 1) {
            throw new RuntimeException('The encoded HLS rendition has no usable H.264 level.');
        }

        $codecs = ['avc1.'.strtolower($codecProfile).str_pad(strtolower(dechex($level)), 2, '0', STR_PAD_LEFT)];
        $audioStream = $streams->audios()->first();
        if ($audioStream) {
            if ($audioStream->get('codec_name') !== 'aac') {
                throw new RuntimeException('The encoded HLS rendition contains an unsupported audio codec.');
            }

            $audioProfile = strtolower((string) $audioStream->get('profile'));
            $codecs[] = 'mp4a.40.'.(str_contains($audioProfile, 'he-aac v2') ? '29' : (str_contains($audioProfile, 'he-aac') ? '5' : '2'));
        }

        $frameRate = $this->parseFrameRate((string) ($videoStream->get('r_frame_rate') ?: $videoStream->get('avg_frame_rate')));
        if ($frameRate <= 0) {
            throw new RuntimeException('The encoded HLS rendition has no usable frame rate.');
        }

        return [
            'codecs' => implode(',', $codecs),
            'frame_rate' => number_format($frameRate, 3, '.', ''),
        ];
    }

    private function parseFrameRate(string $value): float
    {
        if (str_contains($value, '/')) {
            [$numerator, $denominator] = array_pad(explode('/', $value, 2), 2, '0');

            return is_numeric($numerator) && is_numeric($denominator) && (float) $denominator !== 0.0
                ? (float) $numerator / (float) $denominator
                : 0.0;
        }

        return is_numeric($value) ? (float) $value : 0.0;
    }

    private function putFile($disk, string $path, string $localPath, string $contentType): void
    {
        $stream = fopen($localPath, 'rb');
        if (! is_resource($stream)) {
            throw new RuntimeException('Unable to open an HLS output file.');
        }

        try {
            $saved = $disk->put($path, $stream, [
                'visibility' => 'public',
                'ContentType' => $contentType,
                'CacheControl' => config('media.cache.control', 'public, max-age=31536000, immutable'),
            ]);
        } finally {
            fclose($stream);
        }

        if (! $saved) {
            throw new RuntimeException('Unable to publish an HLS output file.');
        }
    }

    private function ffmpegBinary(): string
    {
        $configured = trim((string) config('ffmpeg.ffmpeg_path'));
        if ($configured !== '' && is_executable($configured)) {
            return $configured;
        }

        $binary = (new ExecutableFinder())->find('ffmpeg');
        if (! $binary) {
            throw new RuntimeException('FFmpeg binary is unavailable.');
        }

        return $binary;
    }

    private function sourceSignature(Media $media): string
    {
        $source = $this->sourceDescriptor($media);

        return substr(hash('sha256', implode('|', [
            self::ENCODING_VERSION,
            $source['disk'],
            $source['path'],
            (string) $source['size'],
            $source['mime'],
            $source['extension'],
        ])), 0, 24);
    }

    private function queueAgeSeconds(array $metadata): float
    {
        $queuedAt = data_get($metadata, 'background_processing_dispatched_at');
        if (! $queuedAt) {
            return 0;
        }

        try {
            return max(0, now()->diffInSeconds($queuedAt, true));
        } catch (Throwable) {
            return 0;
        }
    }

    private function safeExtension(?string $extension): string
    {
        $extension = strtolower((string) $extension);

        return preg_match('/\A[a-z0-9]{2,8}\z/', $extension) ? $extension : 'mp4';
    }

    private function updateMetadata(Media $media, callable $mutator, bool $broadcast = true): void
    {
        $media->refresh();
        $media->metadata = $mutator($media->metadata ?? []);
        $media->save();

        if ($broadcast) {
            $ownerId = $media->mediaable instanceof Post
                ? (int) $media->mediaable->user_id
                : ($media->mediaable instanceof StoryFrame ? (int) $media->mediaable->story?->user_id : 0);

            if ($ownerId > 0) {
                event(new MediaUpdatedEvent($media->refresh(), $ownerId));
            }
        }
    }

    private function markSkipped(Media $media, string $sourceSignature, array $dimensions = []): void
    {
        $this->updateMetadata($media, static function (array $metadata) use ($sourceSignature, $dimensions): array {
            $metadata['playback_state'] = 'ready';
            $metadata['background_processing_state'] = 'skipped';
            $metadata['background_processing_progress'] = 100;
            $metadata['background_processing_updated_at'] = now()->toIso8601String();
            $metadata['playback'] = array_merge((array) ($metadata['playback'] ?? []), [
                'hls' => null,
                'hls_state' => 'skipped',
                'hls_prefix' => null,
                'hls_source_signature' => $sourceSignature,
                'encoding_version' => self::ENCODING_VERSION,
                'source_dimensions' => [
                    'width' => (int) ($dimensions['width'] ?? 0),
                    'height' => (int) ($dimensions['height'] ?? 0),
                ],
                'renditions' => [],
            ]);

            return $metadata;
        });
    }

    private function removeDirectory(string $directory): void
    {
        if (! is_dir($directory)) {
            return;
        }

        foreach (new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($directory, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        ) as $entry) {
            $entry->isDir() ? @rmdir($entry->getPathname()) : @unlink($entry->getPathname());
        }
        @rmdir($directory);
    }
}
