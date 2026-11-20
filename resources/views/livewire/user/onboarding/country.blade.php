<div>
    <div class="mb-4 cursor-pointer" x-cloak>
        <x-form.select
            name="country"
            :hasLabel="false"
            :options="$worldCountries"
            wire:model.live="country"
        placeholder="{{ __('labels.whats_country') }}"></x-form.select>

        @if ($countryWasSuggested)
            <div class="mt-2">
                <x-form.helper-text>
                    {{ __('labels.country_ip_suggestion_helper') }}
                </x-form.helper-text>
            </div>
        @endif

    </div>

    <div class="mb-8">
        <x-ui.buttons.pill width="w-full" wire:loading.attr="disabled" type="button" btnText="{{ __('labels.continue') }}" wire:click="submitForm"></x-ui.buttons.pill>
        @if($stepData['is_skippable'])
            <x-ui.buttons.pill width="w-full" variant="link" btnText="{{ __('labels.skip_step') }}" wire:click="skipStep"></x-ui.buttons.pill>
        @endif
    </div>
</div>
