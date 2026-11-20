<?php

namespace App\Livewire\User\Onboarding;

use App\Livewire\User\Onboarding\Base\OnboardingBase;

class City extends OnboardingBase
{
    public string | null $city;
	public bool $cityWasSuggested = false;
	public int $stepIndex;
    public array $stepData;

    public function mount()
    {
        $this->city = me()->city;

        if (! filled($this->city)) {
            $suggestedCity = trim((string) request()->header('CF-IPCity'));

            if ($suggestedCity !== '' && mb_strlen($suggestedCity) <= 32 && ! preg_match('/[\\x00-\\x1F\\x7F]/u', $suggestedCity)) {
                $this->city = $suggestedCity;
                $this->cityWasSuggested = true;
            }
        }
    }

    public function updatedCity(): void
    {
        $this->cityWasSuggested = false;
    }

    public function render()
    {
        return view('livewire.user.onboarding.city');
    }

    public function submitForm()
    {
        $this->validate(rules: [
            'city' => ['required', 'string', 'max:32']
        ], attributes: [
            'city' => __('labels.city'),
        ]);

        me()->update([
            'city' => $this->city
        ]);

        $this->cityWasSuggested = false;

        $this->redirect($this->getNextStepRoute($this->stepIndex));
    }

    public function skipStep()
    {
        if($this->stepData['is_skippable']) {
            if(empty($this->city)) {
                me()->update([
                    'city' => config('user.city')
                ]);
            }

            $this->redirect($this->getNextStepRoute($this->stepIndex));
        }
    }
}
