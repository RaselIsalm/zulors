<?php

namespace Tests\Feature;

use App\Models\EmailConfirmation;
use App\Enums\User\UserStatus;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Tests\TestCase;

class OnboardingCompletionTest extends TestCase
{
    use RefreshDatabase;

    public function test_username_step_marks_signup_complete_and_clears_onboarding_state(): void
    {
        config([
            'brand.default_theme' => 'light',
            'wallet.default_balance' => 0,
        ]);

        $confirmation = EmailConfirmation::query()->create([
            'email' => 'pending-signup@example.test',
            'token' => (string) Str::uuid(),
        ]);

        $confirmationResponse = $this->get(route('user.auth.confirm-signup', ['token' => $confirmation->token]));
        $confirmationResponse->assertRedirect(route('user.onboarding.index', 'profile'));

        $userId = auth()->guard('web')->id();
        $this->assertNotNull($userId);

        $sessionCookieName = config('session.cookie');
        $sessionCookie = $confirmationResponse->getCookie($sessionCookieName);
        $this->assertNotNull($sessionCookie);

        auth()->forgetGuards();

        $usernamePage = $this->withCookie($sessionCookieName, $sessionCookie->getValue())
            ->get(route('user.onboarding.index', 'username'))
            ->assertOk();

        $usernamePageSessionCookie = $usernamePage->getCookie($sessionCookieName);
        $this->assertNotNull($usernamePageSessionCookie);

        preg_match('/wire:snapshot="([^"]+)"/', $usernamePage->getContent(), $snapshotMatch);
        $this->assertArrayHasKey(1, $snapshotMatch, 'The onboarding page should render its Livewire snapshot.');

        $snapshot = html_entity_decode($snapshotMatch[1], ENT_QUOTES | ENT_HTML5);
        $this->assertIsArray(json_decode($snapshot, true));

        $livewireResponse = $this->withCredentials()
            ->withCookie($sessionCookieName, $usernamePageSessionCookie->getValue())
            ->postJson(app('livewire')->getUpdateUri(), [
                'components' => [[
                    'snapshot' => $snapshot,
                    'updates' => [
                        'username' => 'completed_signup',
                        'password' => 'securepass123',
                    ],
                    'calls' => [[
                        'path' => '',
                        'method' => 'submitForm',
                        'params' => [],
                    ]],
                ]],
            ], ['X-Livewire' => 'true'])
            ->assertOk();

        $livewireResponse->assertJsonPath('components.0.effects.redirect', route('user.desktop.index'));

        $updatedSessionCookie = $livewireResponse->getCookie($sessionCookieName);
        $this->assertNotNull($updatedSessionCookie);
        $this->assertSame(
            $usernamePageSessionCookie->getValue(),
            $updatedSessionCookie->getValue(),
            'The final Livewire request should keep the session cookie established by email confirmation.'
        );

        auth()->forgetGuards();
        $this->withCookie($sessionCookieName, $updatedSessionCookie->getValue())
            ->get(route('user.desktop.index'))
            ->assertOk();

        $this->assertAuthenticatedAs(User::query()->findOrFail($userId));

        $user = User::query()->findOrFail($userId);

        $this->assertSame(UserStatus::ACTIVE, $user->status);
        $this->assertTrue(Hash::check('securepass123', $user->password));
        $this->assertDatabaseMissing('onboards', [
            'user_id' => $user->id,
        ]);
    }
}
