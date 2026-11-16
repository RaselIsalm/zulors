<?php

namespace Tests\Feature;

use App\Enums\User\UserRole;
use App\Enums\User\UserStatus;
use App\Enums\User\UserType;
use App\Livewire\User\Auth\Login as LoginComponent;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Livewire\Livewire;
use Tests\TestCase;

class LoginSessionPersistenceTest extends TestCase
{
    use RefreshDatabase;

    public function test_email_login_keeps_its_session_through_the_home_redirect(): void
    {
        config(['brand.default_theme' => 'light']);

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

        Livewire::test(LoginComponent::class)
            ->set('authCreds.login', $user->email)
            ->call('submitForm')
            ->assertSet('loginStep', 2)
            ->set('authCreds.password', 'correct-password')
            ->call('submitForm')
            ->assertRedirect(route('user.desktop.index'));

        auth()->forgetGuards();

        $this->get(route('user.desktop.index'))->assertOk();
        $this->assertAuthenticatedAs($user);
    }
}
