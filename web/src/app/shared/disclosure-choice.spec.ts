import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { NzRadioComponent } from 'ng-zorro-antd/radio';
import { DisclosureChoice, type DisclosureChoiceValue } from './disclosure-choice';
import type { Disclosure } from '../api/generated/types.gen';

/**
 * A stand-in for the report form.
 *
 * The host is not incidental boilerplate. `DisclosureChoice` is a
 * `ControlValueAccessor`, so its only honest test is through a real
 * reactive-form binding: instantiated on its own, the component renders and none
 * of the wiring is exercised, so the tests would pass while `formControlName` in
 * the report page silently produced `null`.
 */
@Component({
  imports: [ReactiveFormsModule, DisclosureChoice],
  template: `<app-disclosure-choice [formControl]="form.controls.disclosure" />`,
})
class HostComponent {
  readonly form = new FormGroup<{ disclosure: FormControl<DisclosureChoiceValue | null> }>({
    // An undecided disclosure blocks submit, so the reporter's form starts
    // invalid. That is the SPEC 3.2 rule travelling with the control.
    disclosure: new FormControl<DisclosureChoiceValue | null>(null),
  });
}

/**
 * SPEC 3.2 assertions.
 *
 * Every test here exists because the failure it guards is silent. A disclosure
 * control that preselects `SHARE_DETAILS` renders perfectly, submits
 * successfully, and quietly strips a reporter's identity protection - nothing
 * throws, no test fails, and the harm lands on a real person. So the rules are
 * asserted directly rather than inferred from the template.
 *
 * The tests drive the real radios rather than calling component internals: a
 * `checked` binding the browser never actually updates would pass a test that
 * called `choose()` directly, and would leave a reporter unable to choose.
 */
describe('DisclosureChoice', () => {
  async function createHarness() {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return {
      fixture,
      form: fixture.componentInstance.form,
      root: () => fixture.nativeElement as HTMLElement,
    };
  }

  /**
   * The `Disclosure` value behind each rendered radio, in document order.
   *
   * Read off the `NzRadioComponent` instances rather than off a DOM attribute.
   * `nz-radio` does not put `value` on the inner `<input type="radio">` - the
   * contract value lives in the component's `nzValue`, which the group matches
   * against - so the `input[value="SHARE_DETAILS"]` selector this file used
   * before the NG-ZORRO migration matched nothing, and the "no radio for
   * SHARE_DETAILS" failures that followed were that rather than a broken
   * control. Going through `By.directive` is also how a test asks "is there a
   * radio here" without assuming a particular tag name.
   *
   * The point of the migration was that the reporter gets the library's keyboard
   * contract, and the point of this helper is unchanged by it: the tests still
   * drive a real rendered radio rather than calling `choose()` directly, so a
   * binding the browser would never actually update still fails here.
   */
  function renderedOptions(fixture: ComponentFixture<HostComponent>): Array<{
    value: Disclosure;
    input: HTMLInputElement;
  }> {
    return fixture.debugElement
      .queryAll(By.directive(NzRadioComponent))
      .map((debugEl) => {
        const instance = debugEl.componentInstance as NzRadioComponent;
        const input = debugEl.nativeElement.querySelector('input[type="radio"]') as
          | HTMLInputElement
          | null;
        if (!input) {
          throw new Error(`the radio for ${String(instance.nzValue)} rendered no input`);
        }
        return { value: instance.nzValue as Disclosure, input };
      });
  }

  /** Click a radio the way a reporter would, and let Angular see it. */
  function choose(fixture: ComponentFixture<HostComponent>, value: Disclosure) {
    const option = renderedOptions(fixture).find((candidate) => candidate.value === value);
    if (!option) {
      throw new Error(`no radio for ${value}`);
    }
    option.input.click();
    fixture.detectChanges();
  }

  function typeEmail(fixture: { detectChanges: () => void }, root: () => HTMLElement, address: string) {
    const input = root().querySelector<HTMLInputElement>('input[type="email"]');
    if (!input) {
      throw new Error('no email field');
    }
    input.value = address;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('preselects nothing', async () => {
    const { root } = await createHarness();

    const radios = [...root().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios.every((radio) => !radio.checked)).toBe(true);
  });

  it('offers both options at equal weight', async () => {
    const { root } = await createHarness();

    // Not a visual regression test - a structural one. The two options are the
    // same element type, so neither can drift into being styled as the "safe
    // default" by accident, and each carries an explanation rather than a bare
    // label.
    const options = [...root().querySelectorAll('.disclosure-option')];
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.tagName).toBe('LABEL');
      expect(option.querySelector('input[type="radio"]')).toBeTruthy();
      expect(
        option.querySelector('.disclosure-option-note')?.textContent?.trim().length ?? 0,
      ).toBeGreaterThan(20);
    }
  });

  it('gives the options the keyboard contract a radio group has to have', async () => {
    // Why `nz-radio-group` rather than bare inputs. Arrow keys move between
    // options and the group is one tab stop; a hand-rolled set gets that only if
    // its author wrote it. A reporter who cannot reach "Keep my identity
    // concealed" with a keyboard has lost the choice this component exists to
    // protect, and nothing else on the page would fail.
    const { root } = await createHarness();

    const group = root().querySelector('.disclosure-options');
    expect(group?.classList).toContain('ant-radio-group');
    expect(root().querySelectorAll('label[nz-radio]')).toHaveLength(2);

    // One `name` across the group is what makes the browser treat these as one
    // control rather than two unrelated radios.
    const names = new Set(
      [...root().querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
        (input) => input.getAttribute('name'),
      ),
    );
    expect(names.size, 'every radio in the group must share one name').toBe(1);
  });

  it('blocks submission until a choice is made', async () => {
    const { form } = await createHarness();

    expect(form.valid).toBe(false);
    expect(form.controls.disclosure.hasError('disclosureRequired')).toBe(true);
  });

  it('emits a shared report with no contact details', async () => {
    const { fixture, form, root } = await createHarness();

    choose(fixture, 'SHARE_DETAILS');
    form.updateValueAndValidity();

    expect(form.valid).toBe(true);
    // Exactly what the contract wants for a shared report. A `reporterContact`
    // here would be rejected by the server, and `contactDisclosureNote` is only
    // meaningful for a concealed one.
    expect(form.controls.disclosure.value).toEqual({ disclosure: 'SHARE_DETAILS' });
  });

  it('asks for an email only once the reporter conceals', async () => {
    const { fixture, form, root } = await createHarness();
    expect(root().querySelector('input[type="email"]')).toBeNull();

    choose(fixture, 'CONCEALED');

    expect(root().querySelector('input[type="email"]')).toBeTruthy();
    // The contract requires a contact channel for a concealed report: a
    // concealed reporter has no account, so without an address there is no way
    // to tell them what happened.
    expect(form.valid).toBe(false);
  });

  it('carries the consent marker and a typed email for a concealed report', async () => {
    const { fixture, form, root } = await createHarness();

    choose(fixture, 'CONCEALED');
    typeEmail(fixture, root, 'Reporter@Example.com');
    form.updateValueAndValidity();

    expect(form.valid).toBe(true);
    expect(form.controls.disclosure.value).toEqual({
      disclosure: 'CONCEALED',
      reporterContact: { type: 'EMAIL', value: 'Reporter@Example.com' },
      // The constant that makes the consent explicit on the wire. It is not a
      // user-editable field, and the contract rejects a concealed report
      // without it.
      contactDisclosureNote: '1',
    });
  });

  it('discards the address when the reporter switches back to sharing', async () => {
    const { fixture, form, root } = await createHarness();

    choose(fixture, 'CONCEALED');
    typeEmail(fixture, root, 'Reporter@Example.com');

    choose(fixture, 'SHARE_DETAILS');
    form.updateValueAndValidity();

    // Not "hidden but still populated": the contract rejects `reporterContact`
    // for a shared report, so a retained value would be a submit-time 422 and,
    // worse, an address sitting in a payload the reporter believes was never
    // sent.
    expect(form.controls.disclosure.value).toEqual({ disclosure: 'SHARE_DETAILS' });
    expect(JSON.stringify(form.getRawValue())).not.toContain('Reporter@Example.com');
    expect(root().querySelector('input[type="email"]')).toBeNull();
  });

  it('rejects a malformed address rather than sending it', async () => {
    const { fixture, form, root } = await createHarness();

    choose(fixture, 'CONCEALED');
    typeEmail(fixture, root, 'not-an-email');
    form.updateValueAndValidity();

    expect(form.valid).toBe(false);
  });

  it('supports exactly the Disclosure values the contract declares', async () => {
    // The radios are literal strings, so a contract that gains a mode must not
    // leave this form silently unable to express it. Asserted against the
    // generated type so the two cannot drift.
    const { fixture } = await createHarness();
    const values = renderedOptions(fixture).map((option) => option.value);

    const supported: Disclosure[] = ['SHARE_DETAILS', 'CONCEALED'];
    expect(values).toEqual(supported);
  });
});
