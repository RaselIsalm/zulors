<?php

use GuzzleHttp\Client;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

$appRoot = realpath((string) (getenv('ZULORS_APP_ROOT') ?: dirname(__DIR__)));
if (! $appRoot || ! is_file($appRoot.'/vendor/autoload.php') || ! is_file($appRoot.'/bootstrap/app.php')) {
    throw new RuntimeException('The Zulors application root could not be located.');
}

require $appRoot.'/vendor/autoload.php';

$app = require $appRoot.'/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

$origins = array_values(array_unique(array_slice($argv, 1) ?: [rtrim((string) config('app.url'), '/')]));
foreach ($origins as $origin) {
    $parts = parse_url($origin);
    if (! in_array($parts['scheme'] ?? '', ['http', 'https'], true) || empty($parts['host'])
        || isset($parts['user']) || isset($parts['fragment']) || ! empty($parts['path'])
        || isset($parts['query'])) {
        throw new InvalidArgumentException('Provide origins without paths, queries, or credentials.');
    }
}

$diskName = (string) config('media.cloudflare.r2.final_disk', 'r2_final');
$disk = Storage::disk($diskName);
$bucket = (string) config("filesystems.disks.{$diskName}.bucket");
if ($bucket === '') {
    throw new RuntimeException('The final R2 media bucket is not configured.');
}

$key = 'uploads/posts/videos/cors-check/'.Str::uuid().'.m3u8';
$body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n";
$objectAttempted = false;
$report = ['checks' => [], 'cleanup_error' => null];
$passed = true;

try {
    $objectAttempted = true;
    $saved = $disk->put($key, $body, [
        'visibility' => 'public',
        'ContentType' => 'application/vnd.apple.mpegurl',
        'CacheControl' => 'no-store, no-cache, max-age=0, must-revalidate',
    ]);
    if (! $saved) {
        throw new RuntimeException('Unable to create the disposable playback probe.');
    }

    $url = $disk->url($key);
    $http = new Client([
        'connect_timeout' => 10,
        'timeout' => 20,
        'http_errors' => false,
        'allow_redirects' => false,
    ]);

    foreach ($origins as $origin) {
        $preflight = $http->request('OPTIONS', $url, ['headers' => [
            'Origin' => $origin,
            'Access-Control-Request-Method' => 'GET',
            'Access-Control-Request-Headers' => 'range',
        ]]);
        $get = $http->get($url, ['headers' => ['Origin' => $origin, 'Cache-Control' => 'no-cache']]);
        $head = $http->head($url, ['headers' => ['Origin' => $origin, 'Cache-Control' => 'no-cache']]);
        $range = $http->get($url, ['headers' => [
            'Origin' => $origin,
            'Range' => 'bytes=0-7',
            'Cache-Control' => 'no-cache',
        ]]);

        $allowedMethods = array_map('trim', explode(',', strtoupper($preflight->getHeaderLine('Access-Control-Allow-Methods'))));
        $allowedHeaders = array_map('trim', explode(',', strtolower($preflight->getHeaderLine('Access-Control-Allow-Headers'))));
        $exposedHeaders = array_map('trim', explode(',', strtolower($range->getHeaderLine('Access-Control-Expose-Headers'))));
        $originAllowed = static fn ($response) => in_array(
            $response->getHeaderLine('Access-Control-Allow-Origin'),
            [$origin, '*'],
            true
        );

        $check = [
            'origin' => $origin,
            'preflight_status' => $preflight->getStatusCode(),
            'get_status' => $get->getStatusCode(),
            'head_status' => $head->getStatusCode(),
            'range_status' => $range->getStatusCode(),
            'allow_origin_on_get' => $originAllowed($get),
            'allow_origin_on_head' => $originAllowed($head),
            'allow_origin_on_range' => $originAllowed($range),
            'range_content_range_visible' => $range->getHeaderLine('Content-Range') !== ''
                && (in_array('content-range', $exposedHeaders, true) || in_array('*', $exposedHeaders, true)),
        ];
        $ok = $check['preflight_status'] >= 200 && $check['preflight_status'] < 300
            && $originAllowed($preflight)
            && in_array('GET', $allowedMethods, true)
            && (in_array('range', $allowedHeaders, true) || in_array('*', $allowedHeaders, true))
            && $check['get_status'] === 200 && $check['allow_origin_on_get']
            && $check['head_status'] === 200 && $check['allow_origin_on_head']
            && $check['range_status'] === 206 && $check['allow_origin_on_range']
            && $check['range_content_range_visible'];

        $check['passed'] = $ok;
        $report['checks'][] = $check;
        $passed = $passed && $ok;
    }
} catch (Throwable $exception) {
    // Exception messages can contain signed URLs; report only the safe class name.
    $report['checks'][] = ['passed' => false, 'error_type' => $exception::class];
    $passed = false;
} finally {
    if ($objectAttempted) {
        try {
            $disk->delete($key);
        } catch (Throwable $exception) {
            $report['cleanup_error'] = $exception::class;
            $passed = false;
        }
    }
}

$report['passed'] = $passed;
echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)."\n";
exit($passed ? 0 : 1);
