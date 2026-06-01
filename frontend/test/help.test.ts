import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bindHelp, openHelpModal } from '../src/help';

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.querySelector('.modal-backdrop')?.remove();
});

describe('openHelpModal', () => {
  it('renders a labelled dialog with a scrollable body', () => {
    openHelpModal();
    const modal = document.querySelector('.modal.help-modal');
    expect(modal).toBeTruthy();
    expect(modal?.getAttribute('role')).toBe('dialog');
    expect(modal?.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('.help-body')).toBeTruthy();
  });

  it('lists the five tabs in the content', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    for (const tab of ['Queue', 'Upcoming', 'Map', 'Profile', 'Log']) {
      expect(text).toContain(tab);
    }
  });

  it('explains the score, the zoom preview, and photo lookup', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    expect(text).toContain('Score');
    expect(text).toContain('Zoom preview');
    expect(text.toLowerCase()).toContain('exif');
  });

  it('closes on the ✕ button', () => {
    openHelpModal();
    document.querySelector<HTMLButtonElement>('.help-close')?.click();
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('closes on backdrop click but not on inner-modal click', () => {
    openHelpModal();
    // Click inside the modal — should NOT close.
    document.querySelector<HTMLElement>('.help-body')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(document.querySelector('.modal-backdrop')).toBeTruthy();
    // Click the backdrop itself — should close.
    const backdrop = document.querySelector<HTMLDivElement>('.modal-backdrop');
    backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('closes on Escape', () => {
    openHelpModal();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('does not stack a second backdrop when opened twice', () => {
    openHelpModal();
    openHelpModal();
    expect(document.querySelectorAll('.modal-backdrop').length).toBe(1);
  });

  it('can reopen after closing', () => {
    openHelpModal();
    document.querySelector<HTMLButtonElement>('.help-close')?.click();
    openHelpModal();
    expect(document.querySelector('.modal-backdrop')).toBeTruthy();
  });
});

describe('bindHelp', () => {
  it('opens the modal when the #help-fab button is clicked', () => {
    const fab = document.createElement('button');
    fab.id = 'help-fab';
    document.body.appendChild(fab);
    bindHelp();
    fab.click();
    expect(document.querySelector('.modal.help-modal')).toBeTruthy();
  });

  it('no-ops when the button is absent (older fixtures)', () => {
    expect(() => bindHelp()).not.toThrow();
  });
});
