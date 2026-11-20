<?php

namespace Tests\Feature;

use App\Enums\User\UserRole;
use App\Enums\User\UserStatus;
use App\Enums\User\UserType;
use App\Livewire\User\Auth\Login as LoginComponent;
use App\Models\User;
use App\Settings\AuthSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Livewire\Livewire;
use Tests\TestCase;

class LoginSessionPersistenceTest extends TestCase
{
    use RefreshDatabase;

    public function test_email_login_keeps_its_session_through_the_home_redirect(): void
    {
        AuthSettings::fake([
            'captcha_enabled' => false,
            'registration_enabled' => true,
            'login_enabled' => true,
            'reg_verification_enabled' => false,
            'auto_verification_enabled' => false,
            'switch_account_enabled' => false,
            'link_accounts_enabled' => false,
            'reg_verification_type' => 'email',
        ]);

        config([
            'brand.default_theme' => 'light',
            'features.login.enabled' => true,
        ]);

        $user = User::query()->create([
            'first_name' => 'Session',
            'last_name' => 'Test',
            'username' => 'session_test',
            'caption' => '@session_test',
            'email' => 'session-test@example.test',
            'phone' => '',
            'website' => '',
            'bio' => '',
            'country' => null,
            'city' => null,
            'birth_day' => null,
            'birth_month' => null,
            'birth_year' => null,
            'age' => null,
            'gender' => 'male',
            'last_active' => now()->timestamp,
            'language' => 'en',
            'avatar' => null,
            'cover' => null,
            'verified' => false,
            'tips' => [],
            'email_verified_at' => now(),
            'password' => Hash::make('correct-password'),
            'role' => UserRole::USER,
            'theme' => 'light',
            'publications_count' => 0,
            'followers_count' => 0,
            'following_count' => 0,
            'status' => UserStatus::ACTIVE,
            'type' => UserType::AUTHOR,
        ]);

        $loginFlow = Livewire::test(LoginComponent::class)
            ->set('authCreds.login', $user->email)
            ->call('submitForm')
            ->assertSet('loginStep', 2);

        $sessionIdBeforeAuthentication = app('session')->driver()->getId();

        $loginFlow
            ->set('authCreds.password', 'correct-password')
            ->call('submitForm')
            ->assertRedirect(route('user.desktop.index'));

        $this->assertNotSame($sessionIdBeforeAuthentication, app('session')->driver()->getId());

        auth()->forgetGuards();

        $this->get(route('user.desktop.index'))->assertOk();
        $this->assertAuthenticatedAs($user);
    }
}
