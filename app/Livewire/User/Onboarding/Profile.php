<?php

namespace App\Livewire\User\Onboarding;

use App\Livewire\User\Onboarding\Base\OnboardingBase;

class Profile extends OnboardingBase
{
    public array $microSteps;
    public array $birthDaysList;
    public array $birthMonthsList;
    public array $birthYearsList;
	public int $stepIndex;
    public array $stepData;

    public array $userData;
    public string | null $birthDay;
    public string | null $birthMonth;
    public string | null $birthYear;

    public function mount()
    {
        $this->birthDaysList = [];
        $this->microSteps = [
            // Social providers usually supply these fields already. Do not
            // make users click through steps that are already complete.
            'first_name' => filled(me()->first_name),
            'last_name' => filled(me()->last_name),
            'birthday' => false,
            'gender' => false
        ];

        $this->birthMonthsList = year_months();

        $this->birthYearsList = birth_years();

        $this->userData = [
            'first_name' => me()->first_name,
            'last_name' => me()->last_name,
            'gender' => me()->gender
        ];

        $this->birthMonth = me()->birth_month;
        $this->birthDay = me()->birth_day;
        $this->birthYear = me()->birth_year;

        $this->assignMonthDays();
    }

    public function saveSelectOption(string $action, $value)
    {
        $this->$action($value);
    }

    public function render()
    {
        return view('livewire.user.onboarding.profile');
    }

    public function submitForm()
    {
        if(empty($this->microSteps['first_name'])) {
            $this->saveFirstName();
        }

        else if(empty($this->microSteps['last_name'])) {
            $this->saveLastName();
        }

        else{
            if (! $this->validateBirthdate()) {
                return;
            }

            // Save the selected values with the Continue action itself.
            // This avoids depending on three separate live model requests
            // having completed before the user taps Continue.
            me()->update([
                'birth_month' => str_pad((string) (int) $this->birthMonth, 2, '0', STR_PAD_LEFT),
                'birth_day' => (string) (int) $this->birthDay,
                'birth_year' => (string) (int) $this->birthYear,
            ]);

            $this->redirect($this->getNextStepRoute($this->stepIndex));
        }
    }

    private function validateBirthdate(): bool
    {
        $this->clearBirthdateErrors();

        $monthValue = trim((string) ($this->birthMonth ?? ''));
        $dayValue = trim((string) ($this->birthDay ?? ''));
        $yearValue = trim((string) ($this->birthYear ?? ''));

        $month = is_numeric($monthValue) ? (int) $monthValue : 0;
        $day = ctype_digit($dayValue) ? (int) $dayValue : 0;
        $year = is_numeric($yearValue) ? (int) $yearValue : 0;

        $monthIsValid = is_numeric($monthValue) && in_array(
            str_pad((string) $month, 2, '0', STR_PAD_LEFT),
            array_column($this->birthMonthsList, 'key'),
            true
        );
        $dayIsValid = ctype_digit($dayValue) && $day >= 1 && $day <= 31;
        $yearIsValid = in_array($yearValue, array_column($this->birthYearsList, 'key'), true);
        $isValid = true;

        foreach ([
            'birthMonth' => [$monthValue, $monthIsValid, 'labels.month'],
            'birthDay' => [$dayValue, $dayIsValid, 'labels.day'],
            'birthYear' => [$yearValue, $yearIsValid, 'labels.year'],
        ] as $field => [$value, $fieldIsValid, $label]) {
            if ($value === '') {
                $this->addError($field, __('validation.required', ['attribute' => __( $label )]));
                $isValid = false;
            } elseif (! $fieldIsValid) {
                $this->addError($field, __('auth.birthdate_required'));
                $isValid = false;
            }
        }

        if ($isValid && ! checkdate($month, $day, $year)) {
            $this->addError('birthDay', __('auth.birthdate_required'));
            $isValid = false;
        }

        if (! $isValid) {
            // Keep the existing validation key for consumers while errors are
            // shown inline on the individual date selectors.
            $this->addError('birthdateError', __('auth.birthdate_required'));
        }

        return $isValid;
    }

    private function clearBirthdateErrors(): void
    {
        foreach (['birthMonth', 'birthDay', 'birthYear', 'birthdateError'] as $field) {
            $this->resetValidation($field);
        }
    }

    private function saveFirstName()
    {
        $this->validate(rules: [
            'userData.first_name' => ['required', 'string', 'max:32']
        ], attributes: [
            'userData.first_name' => __('labels.name')
        ]);

        me()->update([
            'first_name' => $this->userData['first_name']
        ]);

        $this->microSteps['first_name'] = true;
    }

    private function saveLastName()
    {
        $rules = [
            'userData.last_name' => ['string', 'max:32']
        ];

        if((config('user.require.last_name') == true)) {
            array_push($rules['userData.last_name'], 'required');
        }

        $this->validate(rules: $rules, attributes: [
            'userData.last_name' => __('labels.last_name'),
        ]);

        me()->update([
            'last_name' => $this->userData['last_name']
        ]);

        $this->microSteps['last_name'] = true;
    }

    private function assignMonthDays()
    {
        if($this->birthMonth) {
            $this->birthDaysList = month_days($this->birthMonth, $this->birthYear ?? null);
        }
    }

    public function updatedBirthMonth($value) {
        $this->clearBirthdateErrors();

        if(is_numeric($value) && in_array($value, ['01','02','03','04','05','06','07','08','09','10','11', '12'])) {
            $this->assignMonthDays();
        }
    }

    public function updatedBirthYear($value) {
        $this->clearBirthdateErrors();

        if(is_numeric($value)) {
            $this->assignMonthDays();
        }
    }

    public function updatedBirthDay($value) {
        $this->clearBirthdateErrors();
    }

    public function saveGender($value) {
        if(is_string($value) && in_array($value, ['male', 'female'])) {
            me()->update(['gender' => $value]);
        }
    }
}
