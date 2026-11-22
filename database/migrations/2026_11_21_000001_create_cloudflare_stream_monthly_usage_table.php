<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('cloudflare_stream_monthly_usage', function (Blueprint $table): void {
            $table->id();
            $table->char('period', 7)->unique();
            $table->unsignedBigInteger('delivered_seconds')->default(0);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cloudflare_stream_monthly_usage');
    }
};
