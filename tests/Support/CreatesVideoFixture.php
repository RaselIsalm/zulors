<?php

namespace Tests\Support;

use Illuminate\Support\Facades\Storage;
use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

trait CreatesVideoFixture
{
    private function createVideoFixture(): array
    {
        $binary = (new ExecutableFinder())->find('ffmpeg');
        if(! $binary) $this->markTestSkipped('FFmpeg is required.');
        Storage::fake('r2_temp');
        Storage::fake('r2_final');
        config(['filesystems.image_encoder' => 'webp']);
        $disk = Storage::disk('r2_temp');
        $path = 'tmp/direct/videos/worker-test.avi';
        $disk->makeDirectory(dirname($path));
        (new Process([$binary, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
            '-t', '3', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', $disk->path($path)]))->mustRun();
        if(! is_file($disk->path($path))) {
            $this->markTestSkipped('FFmpeg could not create the local video fixture.');
        }
        return [
            'source_path' => $path, 'type' => \App\Enums\Media\MediaType::VIDEO,
            'status' => \App\Enums\Media\MediaStatus::PROCESSING, 'disk' => 'r2_temp', 'thumbnail_disk' => 'r2_final',
            'extension' => 'avi', 'mime' => 'video/x-msvideo', 'size' => $disk->size($path),
            'metadata' => ['provider' => 'r2_direct', 'upload_state' => 'uploaded', 'temp_disk' => 'r2_temp',
                'temp_path' => $path, 'final_disk' => 'r2_final',
                'fixture_sha256' => hash_file('sha256', $disk->path($path))],
        ];
    }

    private function assertOptimizedVideo($media, array $original): void
    {
        $media->refresh();
        $this->assertTrue($media->status->isProcessed());
        $this->assertSame('r2_final', $media->disk);
        $this->assertSame('video/mp4', $media->mime);
        $this->assertStringEndsWith('.webp', $media->thumbnail_path);
        Storage::disk('r2_final')->assertExists([$media->source_path, $media->thumbnail_path]);
        if ($media->mediaable instanceof \App\Models\Post) {
            $originalStorage = data_get($media->metadata, 'original_storage');
            $this->assertSame('r2_final', $originalStorage['disk'] ?? null);
            Storage::disk('r2_final')->assertExists($originalStorage['path'] ?? '');
            $this->assertSame($original['size'], (int) ($originalStorage['size'] ?? 0));
            $this->assertSame(
                data_get($original, 'metadata.fixture_sha256'),
                hash_file('sha256', Storage::disk('r2_final')->path($originalStorage['path']))
            );
        }
        Storage::disk('r2_temp')->assertMissing($original['source_path']);
        $this->assertSame($original['size'], data_get($media->metadata, 'original_size'));
        $this->assertSame(Storage::disk('r2_final')->size($media->source_path), data_get($media->metadata, 'optimized_size'));
    }
}
