<?php

namespace App\Console\Commands;

use App\Enums\Media\MediaStatus;
use App\Enums\Media\MediaType;
use App\Jobs\User\Timeline\GeneratePostVideoHls;
use App\Models\Media;
use App\Models\Post;
use App\Models\StoryFrame;
use App\Services\Media\ReelsHlsRollout;
use Illuminate\Console\Command;

class ReconcileReelHlsProcessing extends Command
{
    protected $signature = 'media:reconcile-reel-hls {--stale-after= : Override stale processing age in minutes} {--retry-failed : Requeue terminally failed HLS processing} {--missing-only : Queue videos with missing or failed HLS output} {--rebuild : Queue videos without the current HLS encoding version} {--media-id=* : Queue specific processed R2 video media IDs} {--include-stories : Include Story videos when their HLS flag is enabled} {--limit=200 : Maximum jobs to queue in this run, up to 200}';

    protected $description = 'Requeue stale, failed, or outdated post and optional Story video HLS jobs.';

    public function handle(ReelsHlsRollout $rollout): int
    {
        $includeStories = (bool) $this->option('include-stories')
            && (bool) config('media.stories_hls.enabled', false);
        if (! $rollout->processingEnabled() && ! $includeStories) {
            $this->info('Reels HLS processing is disabled.');

            return self::SUCCESS;
        }

        $staleAfterMinutes = max(15, (int) ($this->option('stale-after') ?: config('media.reels_hls.stale_after_minutes', 120)));
        $cutoff = now()->subMinutes($staleAfterMinutes)->toIso8601String();
        $query = Media::query()
            ->where('type', MediaType::VIDEO->value)
            ->where('status', MediaStatus::PROCESSED->value)
            ->where('metadata->provider', 'r2')
            ->whereIn('mediaable_type', $includeStories ? [Post::class, StoryFrame::class] : [Post::class]);

        $requestedMediaIds = (array) $this->option('media-id');
        if ($requestedMediaIds !== []) {
            $mediaIds = [];
            foreach ($requestedMediaIds as $mediaId) {
                $mediaId = (string) $mediaId;
                if (! ctype_digit($mediaId) || (int) $mediaId < 1) {
                    $this->error('Every --media-id value must be a positive integer.');

                    return self::INVALID;
                }

                $mediaIds[] = (int) $mediaId;
            }

            $mediaIds = array_values(array_unique($mediaIds));
            if (count($mediaIds) > 200) {
                $this->error('A maximum of 200 media IDs can be queued at a time.');

                return self::INVALID;
            }

            $query
                ->whereIn('id', $mediaIds)
                ->where(function ($state): void {
                    $state->whereNull('metadata->background_processing_state')
                        ->orWhere('metadata->background_processing_state', '<>', 'processing');
                })
                ->orderBy('id');
        } elseif ($this->option('missing-only')) {
            $query
                ->where(function ($state): void {
                    $state->whereNull('metadata->playback->hls_state')
                        ->orWhereIn('metadata->playback->hls_state', ['unset', 'failed']);
                })
                ->where(function ($background): void {
                    $background->whereNull('metadata->background_processing_state')
                        ->orWhereNotIn('metadata->background_processing_state', ['queued', 'processing']);
                })
                ->orderBy('id');
        } elseif ($this->option('rebuild')) {
            $query
                ->where(function ($version): void {
                    $version->whereNull('metadata->playback->encoding_version')
                        ->orWhere('metadata->playback->encoding_version', '<>', GeneratePostVideoHls::ENCODING_VERSION);
                })
                ->where(function ($state): void {
                    $state->whereNull('metadata->background_processing_state')
                        // A prior dispatch can be lost while metadata remains queued.
                        // GeneratePostVideoHls is unique per media ID, so redispatching
                        // queued rows safely recovers that gap without duplicating work.
                        ->orWhereNotIn('metadata->background_processing_state', ['processing']);
                })
                ->orderBy('id');
        } else {
            $query->where(function ($states) use ($cutoff): void {
                $states->where(function ($stale) use ($cutoff): void {
                    $stale->whereIn('metadata->background_processing_state', ['queued', 'processing'])
                        ->where(function ($timestamp) use ($cutoff): void {
                            $timestamp->where('metadata->background_processing_updated_at', '<=', $cutoff)
                                ->orWhere(function ($missing) use ($cutoff): void {
                                    $missing->whereNull('metadata->background_processing_updated_at')
                                        ->where('metadata->background_processing_dispatched_at', '<=', $cutoff);
                                });
                            });
                    });

                if ($this->option('retry-failed')) {
                    $states->orWhere('metadata->background_processing_state', 'failed');
                }
            });
        }

        $limit = max(1, min(200, (int) $this->option('limit')));
        $mediaItems = $query->limit($limit)->get();

        foreach ($mediaItems as $media) {
            $metadata = $media->metadata ?? [];
            $metadata['background_processing_state'] = 'queued';
            $metadata['background_processing_progress'] = 0;
            $metadata['background_processing_updated_at'] = now()->toIso8601String();
            $metadata['background_processing_dispatched_at'] = now()->toIso8601String();
            $metadata['background_processing_error'] = null;
            $metadata['playback_state'] = 'ready';
            $metadata['playback'] = array_merge((array) ($metadata['playback'] ?? []), [
                'hls' => null,
                'hls_state' => 'queued',
            ]);
            $media->metadata = $metadata;
            $media->save();

            GeneratePostVideoHls::dispatch((int) $media->id);
        }

        $label = $includeStories ? 'video' : 'reel';
        $this->info('Requeued '.$mediaItems->count().' '.$label.' HLS job(s).');

        return self::SUCCESS;
    }
}
