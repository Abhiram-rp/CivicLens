import { Component, computed, forwardRef, signal } from '@angular/core';
import {
  AbstractControl,
  ControlValueAccessor,
  FormControl,
  NG_VALUE_ACCESSOR,
  NG_VALIDATORS,
  ReactiveFormsModule,
  ValidationErrors,
  Validator,
  Validators,
} from '@angular/forms';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { NzInputModule } from 'ng-zorro-antd/input';
import { FormsModule } from '@angular/forms';
import type { Disclosure, ReporterContact } from '../api/generated/types.gen';

/**
 * The value this control contributes to the parent reactive form.
 *
 * Exactly the three contract fields in `IssueCreateForm` that the disclosure
 * decision governs. `contactDisclosureNote` is not an input - it is the constant
 * marker that makes the consent explicit on the wire.
 */
export type DisclosureChoiceValue = {
  disclosure: Disclosure | null;
  reporterContact?: ReporterContact;
  contactDisclosureNote?: '1';
};

const EMPTY: DisclosureChoiceValue = { disclosure: null };

/**
 * The disclosure choice: the one control on CivicLens a reporter is asked to
 * fill in that decides who is allowed to know who they are.
 *
 * SPEC 3.2 is the rule this exists to enforce, and it is stricter than an
 * ordinary form field:
 *
 *   - **No default.** `SHARE_DETAILS` is not preselected. A pre-checked "share
 *     my details" is a default consent the reporter never gave, which is exactly
 *     what SPEC 3.2 forbids. Both options render at equal weight.
 *   - **No submission until chosen.** The `Validator` below makes the parent
 *     form invalid while `disclosure` is `null`, so the reporter cannot submit
 *     a report the platform cannot attribute.
 *   - **Contact details only when concealed.** The contact block appears *only*
 *     for `CONCEALED`, because the contract rejects `reporterContact` for
 *     `SHARE_DETAILS`. Rendering it unconditionally would collect an address and
 *     then fail on submit.
 *   - **Switching back discards the address.** Not merely hides it. A
 *     hidden-but-populated control is how a value reaches a payload by accident.
 *   - **The consent marker goes on the wire.** `contactDisclosureNote: '1'` is
 *     required for a concealed report, so it is emitted here as a constant.
 *
 * `Disclosure` and `ReporterContact` come from the generated client rather than
 * being redeclared, so a contract change surfaces as a type error in this file
 * instead of a silently wrong local string union.
 *
 * Implemented as a `ControlValueAccessor` so the parent gets validation,
 * reset and disabled handling from the reactive-forms machinery it already
 * has, rather than from hand-rolled event plumbing.
 */
@Component({
  selector: 'app-disclosure-choice',
  // `nz-radio-group` rather than bare `<input type="radio">`, and the reason is
  // SPEC 3.2 rather than consistency.
  //
  // NG-ZORRO's group is a real `ControlValueAccessor` over a native radio group,
  // so it gets the keyboard contract for free: arrow keys move between options,
  // Space selects, and the group is a single tab stop. A hand-rolled set of
  // radios gets arrow-key behaviour only if the author remembers to write it,
  // and the reporter who cannot reach "Keep my identity concealed" with a
  // keyboard has been stripped of the choice this component exists to protect.
  //
  // `nz-radio` renders its own `<input type="radio">`, so the control is still a
  // real radio to a screen reader and to `disclosure-choice.spec.ts`.
  // `FormsModule` as well as `ReactiveFormsModule`: the radio group is bound
  // with `ngModel`, not `formControl`, because the value it holds is one field
  // of the contract fragment rather than the fragment itself. The email field
  // below still uses `formControl`, because that one *is* a `FormControl` this
  // component owns and validates.
  imports: [ReactiveFormsModule, FormsModule, NzRadioModule, NzInputModule],
  template: `
    <fieldset class="disclosure">
      <legend class="disclosure-legend">Who should be able to see your details?</legend>

      <p class="disclosure-intro" [id]="introId">
        This choice is yours, and you cannot change it later by signing in. It
        decides who at the council can see who reported a problem.
      </p>

      <!--
        The group is bound to a plain signal rather than to the parent form's
        control: that control's value is the whole contract fragment (disclosure
        plus reporterContact plus contactDisclosureNote), not a bare Disclosure.
        The group holds the choice alone and choose() below publishes the rest,
        which keeps the two concerns from being entangled in one binding.
      -->
      <nz-radio-group
        class="disclosure-options"
        [ngModel]="disclosure()"
        (ngModelChange)="choose($event)"
        [nzDisabled]="isDisabled()"
        [attr.aria-describedby]="introId"
      >
        <label class="disclosure-option" nz-radio [nzValue]="'SHARE_DETAILS'">
          <span class="disclosure-option-body">
            <span class="disclosure-option-title">Show my details</span>
            <span class="disclosure-option-note">
              Your name and contact details are visible to council staff handling
              this report. They may contact you for more information.
            </span>
          </span>
        </label>

        <label class="disclosure-option" nz-radio [nzValue]="'CONCEALED'">
          <span class="disclosure-option-body">
            <span class="disclosure-option-title">Keep my identity concealed</span>
            <span class="disclosure-option-note">
              Staff cannot see who you are. You will get a private link to follow
              your report, and we will need an email address to tell you what
              happens to it.
            </span>
          </span>
        </label>
      </nz-radio-group>

      @if (contactErrorId()) {
        <p class="disclosure-error" role="alert" [id]="contactErrorId()">
          {{ errorMessage() }}
        </p>
      }

      @if (isConcealed()) {
        <div class="disclosure-contact">
          <!--
            A plain label element, and a bare nz-input with no wrapper component.

            NG-ZORRO 22 removed nz-input-group, and the field wrapper is implicit
            on nz-input. A label is also the right element regardless: the
            association is what matters, and that is the for/id pair, which
            NG-ZORRO does not add for us here.
          -->
          <label class="disclosure-contact-label" [for]="contactId">
            Email address for updates
          </label>
          <input
            nz-input
            class="disclosure-contact-input"
            [id]="contactId"
            type="email"
            autocomplete="email"
            [formControl]="contact"
            [attr.aria-describedby]="contactHelpId"
          />
          <p class="disclosure-contact-help" [id]="contactHelpId">
            Used only to tell you what happens to this report. It is stored
            separately from the report and is never shown to council staff. You
            will be asked to confirm it before anyone sees the report.
          </p>
          @if (contact.touched && contact.invalid) {
            <p class="disclosure-error" role="alert">
              Enter a valid email address, or choose "Show my details" instead.
            </p>
          }
        </div>
      }
    </fieldset>
  `,
  styles: `
    .disclosure {
      border: 1px solid var(--cl-outline);
      border-radius: 8px;
      padding: 1rem 1.25rem 1.25rem;
      margin: 0 0 1.5rem;
    }

    .disclosure-legend {
      font-size: 1.125rem;
      font-weight: 600;
      line-height: 1.5;
      padding: 0 0.5rem;
    }

    .disclosure-intro {
      color: var(--cl-on-surface-variant);
      margin: 0 0 1rem;
      max-width: 60ch;
    }

    /* Both options are laid out identically and identically sized. Making the
       concealing option visually recessive would nudge reporters towards a
       consent they did not mean to give, which SPEC 3.2 rules out. */
    .disclosure-options {
      display: grid;
      gap: 0.75rem;
    }

    .disclosure-option {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.75rem;
      align-items: start;
      padding: 0.875rem;
      border: 1px solid var(--cl-outline);
      border-radius: 8px;
      cursor: pointer;
    }

    .disclosure-option:hover {
      background: var(--cl-surface-container);
    }

    .disclosure-option:has(input:focus-visible) {
      outline: 2px solid var(--cl-focus);
      outline-offset: 2px;
    }

    .disclosure-option:has(input:checked) {
      border-color: var(--cl-primary);
      background: var(--cl-primary-container);
      color: var(--cl-on-primary-container);
    }

    .disclosure-option:has(input:disabled) {
      cursor: not-allowed;
      opacity: 0.6;
    }

    .disclosure-option-body {
      display: grid;
      gap: 0.25rem;
    }

    .disclosure-option-title {
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.5;
    }

    .disclosure-option-note {
      color: var(--cl-on-surface-variant);
      max-width: 60ch;
    }

    .disclosure-option:has(input:checked) .disclosure-option-note {
      color: inherit;
    }

    .disclosure-contact {
      display: grid;
      gap: 0.375rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--cl-outline);
    }

    .disclosure-contact-label {
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.5;
    }

    /* The input is NG-ZORRO's, so its border, radius, padding, and focus
       treatment come from the library and are not restated here. Only the width
       is ours: an email field at full container width is unreadable on a desktop
       monitor. */
    .disclosure-contact-input {
      max-width: 32rem;
    }

    .disclosure-contact-help,
    .disclosure-error {
      color: var(--cl-on-surface-variant);
      margin: 0;
      max-width: 60ch;
    }

    .disclosure-error {
      color: var(--cl-error);
    }
  `,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => DisclosureChoice), multi: true },
    { provide: NG_VALIDATORS, useExisting: forwardRef(() => DisclosureChoice), multi: true },
  ],
})
export class DisclosureChoice implements ControlValueAccessor, Validator {
  protected readonly introId = 'disclosure-intro';
  protected readonly contactId = 'disclosure-contact';
  protected readonly contactHelpId = 'disclosure-contact-help';

  private readonly _disclosure = signal<Disclosure | null>(null);
  private readonly _disabled = signal(false);
  private readonly _contactError = signal<string | null>(null);

  protected readonly disclosure = this._disclosure.asReadonly();
  protected readonly isDisabled = this._disabled.asReadonly();
  protected readonly isConcealed = computed(() => this._disclosure() === 'CONCEALED');
  protected readonly contactErrorId = computed(() =>
    this._contactError() === null ? null : 'disclosure-error',
  );
  protected readonly errorMessage = computed(
    () =>
      this._contactError() ??
      'Choose one of the two options above. We cannot submit a report without knowing whether to show your details.',
  );

  /**
   * The email field is only validated for a concealed report. Making
   * `required` a function of the current choice is what keeps the form
   * submittable when a `SHARE_DETAILS` reporter has deliberately left it empty.
   */
  protected readonly contact = new FormControl('', {
    nonNullable: true,
    validators: [Validators.email, (control) => (this.isConcealed() ? Validators.required(control) : null)],
  });

  private onChange: (value: DisclosureChoiceValue) => void = () => {};
  private onTouched: () => void = () => {};
  private onValidatorChange: () => void = () => {};

  constructor() {
    // Typed after the choice, or a reporter who enters an address first and
    // then picks "concealed" would silently submit a report with no contact
    // channel. A signal is the right primitive: the control's value is not an
    // event, it is state, and deriving state from events is where this class of
    // bug comes from.
    this.contact.valueChanges.subscribe(() => {
      this.contact.markAsTouched();
      this.publish();
    });
  }

  // --- ControlValueAccessor ----------------------------------------------------------------

  writeValue(value: DisclosureChoiceValue | null): void {
    const next = value ?? EMPTY;
    this._disclosure.set(next.disclosure ?? null);
    // Restored on `patchValue` too, not just on `choose`, so a form `reset()` to
    // a concealed value repopulates the address instead of showing a blank
    // field the reporter had already given us.
    this.contact.setValue(next.reporterContact?.value ?? '', { emitEvent: false });
    this.publish(false);
  }

  registerOnChange(fn: (value: DisclosureChoiceValue) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this._disabled.set(isDisabled);
    if (isDisabled) {
      this.contact.disable({ emitEvent: false });
    } else {
      this.contact.enable({ emitEvent: false });
    }
  }

  // --- Validator ----------------------------------------------------------------------------

  validate(_control: AbstractControl): ValidationErrors | null {
    if (this._disclosure() === null) {
      // SPEC 3.2: no default, and no submission until one is chosen.
      return { disclosureRequired: true };
    }
    if (this._disclosure() === 'CONCEALED' && this.contact.invalid) {
      return { disclosureContact: true };
    }
    return null;
  }

  registerOnValidatorChange(fn: () => void): void {
    this.onValidatorChange = fn;
  }

  /**
   * Called by the `nz-radio-group` rather than by two `(change)` bindings.
   *
   * The value arrives as whatever `[nzValue]` held, which the template pins to
   * the contract's literals. It is re-typed to `Disclosure` here rather than
   * cast blindly, so a value that is neither contract member is ignored instead
   * of being written into a form that will submit it - the failure this
   * component exists to prevent, reached by a new route.
   */
  protected choose(choice: unknown): void {
    if (choice !== 'SHARE_DETAILS' && choice !== 'CONCEALED') {
      return;
    }
    this._disclosure.set(choice);
    this.onTouched();

    // Switching back to `SHARE_DETAILS` must *discard* the address, not merely
    // hide it: the contract rejects `reporterContact` for a shared report.
    if (choice === 'SHARE_DETAILS') {
      this.contact.setValue('', { emitEvent: false });
      this._contactError.set(null);
    }

    this.publish();
  }

  /**
   * Recompute the error to show, then hand the parent the contract fragment.
   *
   * `propagate` is false while the parent is writing *into* the control, so
   * `writeValue` does not bounce a value straight back out and overwrite
   * whatever the parent is in the middle of setting.
   */
  private publish(propagate = true): void {
    const disclosure = this._disclosure();

    // The contact validators are a function of the current choice, and Angular
    // only re-runs a control's validators when its value or its validators
    // change. Switching the radio changes neither, so without this an empty
    // address would still look valid and a concealed report would be submitted
    // with no way to contact its reporter.
    this.contact.updateValueAndValidity({ emitEvent: false });

    this._contactError.set(
      disclosure === 'CONCEALED' && this.contact.invalid
        ? 'Enter a valid email address, or choose "Show my details" instead.'
        : null,
    );

    // The "choose one" message is gated on the parent having attempted a
    // submit, not on the control being touched: showing a red error to a
    // reporter who is still reading the two options is exactly the pressure
    // that produces a default-consent click.
    this.onValidatorChange();

    if (!propagate) {
      return;
    }

    if (disclosure === null) {
      this.onChange({ ...EMPTY });
    } else if (disclosure === 'CONCEALED') {
      this.onChange({
        disclosure,
        reporterContact: { type: 'EMAIL', value: this.contact.value },
        contactDisclosureNote: '1',
      });
    } else {
      this.onChange({ disclosure });
    }
  }
}
