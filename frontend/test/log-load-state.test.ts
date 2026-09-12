import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATION_FALLBACK_DENYLIST } from '../src/sw-navigation';

const identity = vi.hoisted(() => ({ account: { name: 'jessica', displayName: 'Jessica Meir', isVerified: true } }));
vi.mock('../src/profile-session', () => ({
  getAccountProfile: () => identity.account,
  getAuthorizedProfiles: () => [identity.account],
  getSignedInAccountProfile: () => identity.account,
  resolveAccountProfile: async () => identity.account,
}));

const appHtml = readFileSync(`${process.cwd()}/index.html`, 'utf8');
const logMarkup = appHtml.match(/<section id="log-pane"[\s\S]*?<\/section>/)![0];
beforeEach(() => {
  document.body.innerHTML = logMarkup;
  identity.account.name = 'jessica';
  identity.account.displayName = 'Jessica Meir';
  identity.account.isVerified = true;
  localStorage.clear();
  localStorage.setItem('opd-calib-queue:jessica', '[{"profile":"jessica","rating":4}]');
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Log session recovery', () => {
  it('does not present a sign-in link before any authentication failure', () => {
    expect(document.querySelector('#log-pane a')).toBeNull();
  });

  it('the global expired-session banner uses the same supported recovery route and keeps the active crew profile', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="status-banner"></div>');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const { setAuthBanner } = await import('../src/main');
    setAuthBanner({ level: 'red', text: 'Sign in again to sync' });
    document.querySelector<HTMLElement>('#status-banner')!.click();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/api/app?u=jessica');
    expect(localStorage.getItem('opd-calib-queue:jessica')).toBe('[{"profile":"jessica","rating":4}]');
  });

  it('shows an honest empty history with no sign-in control after an authenticated read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"entries":[]}')));
    const { loadLogPane } = await import('../src/main');
    await loadLogPane();
    expect(document.querySelector<HTMLElement>('#log-empty')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#log-notice')?.hidden).toBe(true);
    expect(document.querySelector('#log-pane a')).toBeNull();
  });

  it.each([401, 403, 302])('offers working profile-preserving recovery only after HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    const { loadLogPane } = await import('../src/main');
    await loadLogPane();
    const link = document.querySelector<HTMLAnchorElement>('#log-notice a')!;
    expect(link.textContent).toBe('Sign in and reload');
    expect(link.getAttribute('href')).toBe('/api/app?u=jessica');
    expect(NAVIGATION_FALLBACK_DENYLIST.some((rule) => rule.test(link.pathname + link.search))).toBe(true);
    expect(document.querySelector<HTMLElement>('#log-empty')?.hidden).toBe(true);
    expect(document.querySelector('#log-notice')?.textContent).toContain('saved ratings have been kept');
    expect(localStorage.getItem('opd-calib-queue:jessica')).toBe('[{"profile":"jessica","rating":4}]');
  });

  it('recognizes an opaque Access redirect as an authentication failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'opaqueredirect', status: 0, ok: false })));
    const { loadLogPane } = await import('../src/main');
    await loadLogPane();
    expect(document.querySelector('#log-notice a')?.textContent).toBe('Sign in and reload');
  });

  it('does not ask for sign-in or claim empty history on a lost connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const { loadLogPane } = await import('../src/main');
    await loadLogPane();
    expect(document.querySelector('#log-pane a')).toBeNull();
    expect(document.querySelector('#log-notice')?.textContent).toContain('reconnect, then reopen Log');
    expect(document.querySelector<HTMLElement>('#log-empty')?.hidden).toBe(true);
  });

  it.each(['<html>Unexpected response</html>', '{"entries":null}', '{"entries":[null]}'])('handles an invalid read without a false sign-in prompt: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const { loadLogPane } = await import('../src/main');
    await loadLogPane();
    expect(document.querySelector('#log-pane a')).toBeNull();
    expect(document.querySelector('#log-notice')?.textContent).toContain('Could not load your log');
    expect(document.querySelector<HTMLElement>('#log-empty')?.hidden).toBe(true);
  });

  it('does not read or reauthenticate a tab whose cached profile is offline', async () => {
    identity.account.isVerified = false;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { loadLogPane } = await import('../src/main');
    await loadLogPane();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('#log-pane a')).toBeNull();
    expect(document.querySelector('#log-notice')?.textContent).toContain('reconnect, then reopen Log');
  });

  it('clears obsolete recovery after a successful refresh and shows the saved log', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [{
        target_id: 'caribou', target_name: 'Caribou, Maine', pass_time: '2026-09-12T12:00:00Z', action: 'shoot',
      }] })));
    vi.stubGlobal('fetch', fetch);
    const { loadLogPane } = await import('../src/main');
    await loadLogPane();
    expect(document.querySelector('#log-notice a')).not.toBeNull();
    await loadLogPane();
    expect(document.querySelector('#log-pane a')).toBeNull();
    expect(document.querySelector<HTMLElement>('#log-notice')?.hidden).toBe(true);
    expect(document.querySelector('#log-list')?.textContent).toContain('Caribou, Maine');
    expect(document.querySelector('#log-list .row-rate-btn')).not.toBeNull();
    expect(localStorage.getItem('opd-calib-queue:jessica')).toBe('[{"profile":"jessica","rating":4}]');
  });

  it('ignores a late auth denial from an older load after a newer successful read', async () => {
    let finishOld!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(new Response('{"entries":[]}')));
    const { loadLogPane } = await import('../src/main');
    const oldLoad = loadLogPane();
    await loadLogPane();
    finishOld(new Response('', { status: 401 }));
    await oldLoad;
    expect(document.querySelector('#log-pane a')).toBeNull();
    expect(document.querySelector<HTMLElement>('#log-notice')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#log-empty')?.hidden).toBe(false);
  });

  it('ignores an outstanding log read after the active profile changes', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const { loadLogPane } = await import('../src/main');
    const loading = loadLogPane();
    identity.account.name = 'anil';
    finish(new Response('', { status: 401 }));
    await loading;
    expect(document.querySelector('#log-pane a')).toBeNull();
    expect(document.querySelector<HTMLElement>('#log-notice')?.hidden).toBe(true);
  });

  it('does not open an old log row for rating under a different profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ entries: [{
      target_id: 'caribou', target_name: 'Caribou', pass_time: '2026-09-12T12:00:00Z', action: 'shoot',
    }] }))));
    const { loadLogPane } = await import('../src/main');
    await loadLogPane();
    identity.account.name = 'anil';
    document.querySelector<HTMLButtonElement>('.row-rate-btn')!.click();
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('does not post an already-open rating when the active profile changes', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { openRateModal } = await import('../src/log');
    const modal = openRateModal({
      target_id: 'caribou', target_name: 'Caribou', pass_time: '2026-09-12T12:00:00Z', action: 'shoot',
    });
    document.querySelector<HTMLButtonElement>('.star-btn')!.click();
    identity.account.name = 'anil';
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-shoot')!.click();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-actions .btn-shoot')?.textContent).toContain('Profile changed');
    expect(localStorage.getItem('opd-calib-queue:jessica')).toBe('[{"profile":"jessica","rating":4}]');
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-skip')!.click();
    expect(await modal).toBe(false);
  });
});
