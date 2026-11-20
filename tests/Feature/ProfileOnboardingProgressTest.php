<?php

namespace Tests\Feature;

use App\Enums\User\UserRole;
use App\Enums\User\UserStatus;
use App\Enums\User\UserType;
use App\Livewire\User\Onboarding\City;
use App\Livewire\User\Onboarding\Country;
use App\Livewire\User\Onboarding\Profile;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Livewire\Livewire;
use Tests\TestCase;

class ProfileOnboardingProgressTest extends TestCase
{
    use RefreshDatabase;

    public function test_prefilled_google_names_skip_completed_steps_and_birthdate_saves_on_continue(): void
    {
        $user = $this->createOnboardingUser([
            'first_name' => 'Google',
            'last_name' => 'User',
        ]);
        $this->actingAs($user);

        $component = Livewire::test(Profile::class, [
            'stepIndex' => 0,
            'stepData' => config('user.onboarding_steps.profile'),
        ])
            ->assertSet('microSteps.first_name', true)
            ->assertSet('microSteps.last_name', true)
            ->set('birthMonth', '02')
            ->set('birthDay', '29')
            ->set('birthYear', '2000');

        // Dropdown changes stay in the Livewire form until Continue is tapped.
        $this->assertNull($user->fresh()->birth_month);
        $this->assertNull($user->fresh()->birth_day);
        $this->assertNull($user->fresh()->birth_year);

        $component
            ->call('submitForm')
            ->assertRedirect(route('user.onboarding.index', 'country'));

        $this->assertSame('02', $user->fresh()->birth_month);
        $this->assertSame('29', $user->fresh()->birth_day);
        $this->assertSame('2000', $user->fresh()->birth_year);
    }

    public function test_invalid_birthdate_is_rejected_without_advancing(): void
    {
        $user = $this->createOnboardingUser([
            'first_name' => 'Google',
            'last_name' => 'User',
        ]);
        $this->actingAs($user);

        Livewire::test(Profile::class, [
            'stepIndex' => 0,
            'stepData' => config('user.onboarding_steps.profile'),
        ])
            ->set('birthMonth', '02')
            ->set('birthDay', '31')
            ->set('birthYear', '2000')
            ->call('submitForm')
            ->assertHasErrors(['birthdateError']);

        $this->assertNull($user->fresh()->birth_month);
        $this->assertNull($user->fresh()->birth_day);
        $this->assertNull($user->fresh()->birth_year);
    }

    public function test_missing_birthdate_shows_inline_errors_on_all_date_selectors(): void
    {
        $user = $this->createOnboardingUser([
            'first_name' => 'Google',
            'last_name' => 'User',
        ]);
        $this->actingAs($user);

        $component = Livewire::test(Profile::class, [
            'stepIndex' => 0,
            'stepData' => config('user.onboarding_steps.profile'),
        ])
            ->call('submitForm')
            ->assertHasErrors(['birthMonth', 'birthDay', 'birthYear']);

        $this->assertSame(3, substr_count($component->html(), 'border-red-900 bg-red-900/5'));
        foreach (['labels.month', 'labels.day', 'labels.year'] as $label) {
            $this->assertStringContainsString(
                __('validation.required', ['attribute' => __($label)]),
                $component->html()
            );
        }
        $this->assertNull($user->fresh()->birth_month);
        $this->assertNull($user->fresh()->birth_day);
        $this->assertNull($user->fresh()->birth_year);
    }

    public function test_country_is_suggested_from_cloudflare_country_header_and_saved_on_continue(): void
    {
        $user = $this->createOnboardingUser();
        $this->actingAs($user);

        $component = Livewire::withHeaders(['CF-IPCountry' => 'bd'])->test(Country::class, [
            'stepIndex' => 1,
            'stepData' => config('user.onboarding_steps.country'),
        ])
            ->assertSet('country', 'BD')
            ->assertSet('countryWasSuggested', true);

        $this->assertNull($user->fresh()->country);

        $component
            ->call('submitForm')
            ->assertRedirect(route('user.onboarding.index', 'city'));

        $this->assertSame('BD', $user->fresh()->country);
    }

    public function test_saved_country_wins_over_ip_suggestion_and_invalid_ip_country_is_ignored(): void
    {
        $user = $this->createOnboardingUser(['country' => 'US']);
        $this->actingAs($user);

        Livewire::withHeaders(['CF-IPCountry' => 'BD'])->test(Country::class, [
            'stepIndex' => 1,
            'stepData' => config('user.onboarding_steps.country'),
        ])
            ->assertSet('country', 'US')
            ->assertSet('countryWasSuggested', false);

        $user->update(['country' => null]);

        Livewire::withHeaders(['CF-IPCountry' => 'XX'])->test(Country::class, [
            'stepIndex' => 1,
            'stepData' => config('user.onboarding_steps.country'),
        ])
            ->assertSet('country', null)
            ->assertSet('countryWasSuggested', false);
    }

    public function test_city_is_suggested_from_cloudflare_location_header_and_saved_on_continue(): void
    {
        $user = $this->createOnboardingUser(['country' => 'BD']);
        $this->actingAs($user);

        $component = Livewire::withHeaders(['CF-IPCity' => 'Dhaka'])->test(City::class, [
            'stepIndex' => 2,
            'stepData' => config('user.onboarding_steps.city'),
        ])
            ->assertSet('city', 'Dhaka')
            ->assertSet('cityWasSuggested', true);

        $this->assertNull($user->fresh()->city);

        $component
            ->call('submitForm')
            ->assertRedirect(route('user.onboarding.index', 'username'));

        $this->assertSame('Dhaka', $user->fresh()->city);
    }

    private function createOnboardingUser(array $attributes = []): User
    {
        return User::query()->create(array_merge([
            'first_name' => '',
            'last_name' => '',
            'username' => 'onboarding_' . random_int(100000, 999999),
            'caption' => '@onboarding',
            'email' => 'onboarding-' . random_int(100000, 999999) . '@example.test',
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
            'status' => UserStatus::ONBOARDING,
            'type' => UserType::AUTHOR,
        ], $attributes));
    }
}
