import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTokenModal } from '../src/main';

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});
afterEach(() => {
  // Clean up any modal that didn't resolve in case a test fails mid-flow
  document.querySelector('.modal-backdrop')?.remove();
});

describe('openTokenModal', () => {
  it('renders a password-type input (masked, no autofill)', () => {
    void openTokenModal(false);
    const input = document.querySelector<HTMLInputElement>('.token-input');
    expect(input).toBeTruthy();
    expect(input?.type).toBe('password');
    expect(input?.autocomplete).toBe('off');
    expect(input?.spellcheck).toBe(false);
  });

  it('shows "Set" title for a fresh user, "Change" for a returning one', async () => {
    void openTokenModal(false);
    const titleNew = document.querySelector('.modal h3')?.textContent ?? '';
    expect(titleNew.toLowerCase()).toContain('set');
    document.querySelector('.modal-backdrop')?.remove();

    void openTokenModal(true);
    const titleChange = document.querySelector('.modal h3')?.textContent ?? '';
    expect(titleChange.toLowerCase()).toContain('change');
  });

  it('resolves null when Cancel is clicked', async () => {
    const p = openTokenModal(false);
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-skip')?.click();
    const result = await p;
    expect(result).toBeNull();
  });

  it('resolves null when the backdrop is clicked', async () => {
    const p = openTokenModal(false);
    const backdrop = document.querySelector<HTMLDivElement>('.modal-backdrop');
    backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const result = await p;
    expect(result).toBeNull();
  });

  it('resolves the trimmed token when Save is clicked', async () => {
    const p = openTokenModal(false);
    const input = document.querySelector<HTMLInputElement>('.token-input')!;
    input.value = '  secret-token-123  ';
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-shoot')?.click();
    const result = await p;
    expect(result).toBe('secret-token-123');
  });

  it('resolves empty string when Save is clicked with no input (clear-token intent)', async () => {
    const p = openTokenModal(true);
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-shoot')?.click();
    const result = await p;
    expect(result).toBe('');
  });

  it('resolves on Enter key', async () => {
    const p = openTokenModal(false);
    const input = document.querySelector<HTMLInputElement>('.token-input')!;
    input.value = 'tok';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const result = await p;
    expect(result).toBe('tok');
  });

  it('resolves null on Escape key', async () => {
    const p = openTokenModal(false);
    const input = document.querySelector<HTMLInputElement>('.token-input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const result = await p;
    expect(result).toBeNull();
  });

  it('removes the modal from DOM on close', async () => {
    const p = openTokenModal(false);
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-skip')?.click();
    await p;
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('wipes the input value on close (defense vs cached field state)', async () => {
    const p = openTokenModal(false);
    const input = document.querySelector<HTMLInputElement>('.token-input')!;
    input.value = 'leaked';
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-skip')?.click();
    await p;
    expect(input.value).toBe('');
  });
});
