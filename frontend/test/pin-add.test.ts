/**
 * Tests for the pin-popup "Add to my targets" footer (Jack's ask,
 * 2026-06-11) — map.ts buildPinAddFooter + coordTargetName.
 *
 * The add pathway itself (optimistic save → POST → rollback + toast,
 * D1=B) is profile-crud's handleAdd, already covered by its own tests;
 * here we pin the popup-side wiring: name pre-fill/fallback, validation
 * surfacing, success-closes / failure-stays semantics, and that the
 * footer hands handleAdd a fully validated PersonalTarget.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPinAddFooter, coordTargetName } from '../src/map';
import type { PersonalTarget } from '../src/profile';

describe('coordTargetName', () => {
  it('formats hemispheres and precision like the popup title', () => {
    expect(coordTargetName(42.36, -71.06, 1)).toBe('42.4°N 71.1°W');
    expect(coordTargetName(-33.9, 151.2, 1)).toBe('33.9°S 151.2°E');
    expect(coordTargetName(0, 0, 0)).toBe('0°N 0°E');
  });
});

describe('buildPinAddFooter', () => {
  let added: Array<{ profile: string; target: PersonalTarget }>;
  let addResult: 'ok' | string;
  let closed: number;

  const addFn = async (profile: string, target: PersonalTarget): Promise<'ok' | string> => {
    added.push({ profile, target });
    return addResult;
  };

  beforeEach(() => {
    added = [];
    addResult = 'ok';
    closed = 0;
    document.body.innerHTML = '';
  });

  const build = (): HTMLElement => {
    const el = buildPinAddFooter(42.36, -71.06, 1, 'jack', () => { closed += 1; }, addFn);
    document.body.appendChild(el);
    return el;
  };

  const clickAdd = (el: HTMLElement): void => {
    el.querySelector<HTMLButtonElement>('.pin-add-button')!.click();
  };

  it('renders the button; tapping reveals the form pre-filled with the coord name', () => {
    const el = build();
    expect(el.querySelector('.pin-add-button')!.textContent).toBe('➕ Add to my targets');
    expect(el.querySelector('.pin-add-form')).toBeNull();
    clickAdd(el);
    expect(el.querySelector('.pin-add-button')).toBeNull(); // button swapped out
    const input = el.querySelector<HTMLInputElement>('.pin-add-name')!;
    expect(input.value).toBe('42.4°N 71.1°W');
  });

  it('save hands handleAdd a validated target with the edited name + pin coords', async () => {
    const el = build();
    clickAdd(el);
    const input = el.querySelector<HTMLInputElement>('.pin-add-name')!;
    input.value = "Ben's house";
    el.querySelector<HTMLButtonElement>('.pin-add-save')!.click();
    await vi.waitFor(() => expect(added).toHaveLength(1));
    const { profile, target } = added[0]!;
    expect(profile).toBe('jack');
    expect(target.name).toBe("Ben's house");
    expect(target.lat).toBe(42.36);
    expect(target.lon).toBe(-71.06);
    expect(target.priority).toBe(5); // curated default
    expect(target.id).toMatch(/^personal:jack:/); // minted id
    expect(closed).toBe(1); // success closes the popup
  });

  it('whitespace-only name falls back to the coordinate name', async () => {
    const el = build();
    clickAdd(el);
    el.querySelector<HTMLInputElement>('.pin-add-name')!.value = '   ';
    el.querySelector<HTMLButtonElement>('.pin-add-save')!.click();
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]!.target.name).toBe('42.4°N 71.1°W');
  });

  it('Enter in the name field submits (keyboard path)', async () => {
    const el = build();
    clickAdd(el);
    const input = el.querySelector<HTMLInputElement>('.pin-add-name')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(added).toHaveLength(1));
  });

  it('failure (rollback/duplicate) keeps the popup open and shows why', async () => {
    addResult = 'Add failed: the planner could not be reached.';
    const el = build();
    clickAdd(el);
    el.querySelector<HTMLButtonElement>('.pin-add-save')!.click();
    await vi.waitFor(() => {
      const err = el.querySelector<HTMLElement>('.pin-add-error')!;
      expect(err.hidden).toBe(false);
      expect(err.textContent).toContain('could not be reached');
    });
    expect(closed).toBe(0); // popup stays for rename/retry
    const save = el.querySelector<HTMLButtonElement>('.pin-add-save')!;
    expect(save.disabled).toBe(false); // re-enabled for retry
    expect(save.textContent).toBe('Save');
  });

  it('cancel restores the add button without touching the profile', () => {
    const el = build();
    clickAdd(el);
    el.querySelector<HTMLButtonElement>('.pin-add-cancel')!.click();
    expect(el.querySelector('.pin-add-form')).toBeNull();
    expect(el.querySelector('.pin-add-button')).not.toBeNull();
    expect(added).toHaveLength(0);
  });

  it('over-long names surface the validation error inline (popup stays open)', async () => {
    const el = build();
    clickAdd(el);
    const input = el.querySelector<HTMLInputElement>('.pin-add-name')!;
    // maxLength guards typing, but programmatic/pasted values can exceed it.
    Object.defineProperty(input, 'value', { value: 'x'.repeat(201), writable: true });
    el.querySelector<HTMLButtonElement>('.pin-add-save')!.click();
    await vi.waitFor(() => {
      expect(el.querySelector<HTMLElement>('.pin-add-error')!.hidden).toBe(false);
    });
    expect(added).toHaveLength(0); // never reached handleAdd
  });
});
