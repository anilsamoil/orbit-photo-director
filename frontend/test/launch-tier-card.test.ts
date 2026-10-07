import { beforeEach, describe, expect, it, vi } from 'vitest';

import { launchCatalog } from '../src/launch-catalog';
import { openTierDetails, renderTierCard } from '../src/launch-tier-card';
import { tiersAt, type TierLaunch } from '../src/launch-tiers';
import type { LaunchCatalog, LaunchCatalogItem } from '../src/launch-schema';
import { catalog, catalogItem, iso, NOW } from './launch-fixtures';

beforeEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
});

function fact(root: ParentNode, label: string): string {
  const line = [...root.querySelectorAll('.launch-fact')].find((row) => row.querySelector('.launch-fact-label')?.textContent === label);
  return line?.lastElementChild?.textContent ?? '';
}

function shotItem(over: Partial<LaunchCatalogItem> = {}): LaunchCatalogItem {
  return catalogItem({ event_id: 'windowed', name: 'Windowed', tier: 'shot', ...over });
}

function pin(item: LaunchCatalogItem, over: Partial<LaunchCatalog> = {}): TierLaunch {
  const launch = tiersAt(catalog([item], over), NOW)?.pins[0];
  if (!launch) throw new Error('missing pin');
  return launch;
}

async function hold(body: LaunchCatalog): Promise<void> {
  const text = JSON.stringify(body);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const pointer = {
    schema_version: 2,
    revision: body.revision,
    generated_at: body.generated_at,
    valid_until: body.geometry_valid_until,
    path: `launch/catalog/v/${body.revision}.json`,
    sha256,
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (path === '/launch/catalog/latest.json') {
      return new Response(JSON.stringify(pointer), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === `/${pointer.path}`) {
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('missing', { status: 404 });
  }));
  await launchCatalog.refresh(true);
}

function details(): HTMLDialogElement {
  const dialog = document.querySelector('.launch-dialog');
  if (!(dialog instanceof HTMLDialogElement)) throw new Error('missing dialog');
  return dialog;
}

describe('tier schedule lines', () => {
  it('labels NET, both window endpoints, and best time in UTC and Houston', () => {
    const card = renderTierCard(pin(shotItem()));
    expect(fact(card, 'NET')).toBe('7 Sep 2026, 12:10:00 UTC · 7 Sep 2026, 07:10:00 CDT');
    expect(fact(card, 'Launch window')).toBe('7 Sep 2026, 12:10:00–12:20:00 UTC · 7 Sep 2026, 07:10:00–07:20:00 CDT');
    expect(fact(card, 'Best time')).toBe('7 Sep 2026, 12:11:00 UTC · 7 Sep 2026, 07:11:00 CDT');
    expect(fact(card, 'NET')).not.toContain('12:11:00');
    expect(fact(card, 'NET')).not.toContain('12:20:00');
    expect(fact(card, 'Best time')).not.toContain('12:20:00');
  });

  it('keeps both dates when the window crosses midnight', () => {
    const card = renderTierCard(pin(shotItem({
      schedule: {
        net: '2026-09-07T23:30:00Z',
        window_start: '2026-09-07T23:30:00Z',
        window_end: '2026-09-08T00:30:00Z',
        precision: 'Second',
        status: 'Go',
        destination: 'ISS',
      },
    }), { geometry_valid_until: iso(24 * 60), schedule_valid_until: iso(24 * 60) }));
    expect(fact(card, 'Launch window')).toBe('7 Sep 2026, 23:30:00 UTC – 8 Sep 2026, 00:30:00 UTC · 7 Sep 2026, 18:30:00–19:30:00 CDT');
    expect(fact(card, 'NET')).toBe('7 Sep 2026, 23:30:00 UTC · 7 Sep 2026, 18:30:00 CDT');
    expect(fact(card, 'Best time')).toBe('7 Sep 2026, 12:11:00 UTC · 7 Sep 2026, 07:11:00 CDT');
  });
});

describe('tier details follow the catalog', () => {
  it('shows the same schedule while the event is current', async () => {
    const item = shotItem();
    await hold(catalog([item]));
    openTierDetails(pin(item));
    const dialog = details();
    expect(fact(dialog, 'Tier')).toBe('Shot');
    expect(fact(dialog, 'NET')).toBe('7 Sep 2026, 12:10:00 UTC · 7 Sep 2026, 07:10:00 CDT');
    expect(fact(dialog, 'Launch window')).toContain('12:10:00–12:20:00 UTC');
    expect(fact(dialog, 'Best time')).toContain('12:11:00 UTC');
    expect(dialog.querySelector('[data-tier-track]')?.textContent).toContain('28.50, -80.60');
  });

  it.each([
    ['geometry', iso(10), catalog([shotItem()])],
    ['schedule', iso(5), catalog([shotItem()], { schedule_valid_until: iso(5) })],
  ])('drops the shot claim when the %s lease ends', async (_lease, expiry, body) => {
    await hold(body);
    openTierDetails(pin(shotItem()));
    const dialog = details();
    expect(fact(dialog, 'Tier')).toBe('Shot');
    launchCatalog.tick(NOW);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiry));
    launchCatalog.tick(Date.parse(expiry));
    expect(dialog.querySelector('[data-tier-evidence="expired"]')?.textContent).toBe('STALE / EXPIRED DATA');
    expect(fact(dialog, 'Tier')).toBe('');
    expect(dialog.querySelector('[data-tier-track]')).toBeNull();
    expect(dialog.textContent).not.toContain('28.50');
    expect(dialog.textContent).not.toContain('Shot');
  });

  it('drops the shot claim when a newer pointer supersedes the hold', async () => {
    await hold(catalog([shotItem()]));
    openTierDetails(pin(shotItem()));
    const dialog = details();
    const next = catalog([shotItem()], { revision: 'r2', generated_at: iso(-1) });
    const text = JSON.stringify(next);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const pointer = {
      schema_version: 2,
      revision: next.revision,
      generated_at: next.generated_at,
      valid_until: next.geometry_valid_until,
      path: `launch/catalog/v/${next.revision}.json`,
      sha256,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path === '/launch/catalog/latest.json') {
        return new Response(JSON.stringify(pointer), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('missing', { status: 404 });
    }));
    await launchCatalog.refresh(true);
    expect(dialog.querySelector('[data-tier-evidence="expired"]')?.textContent).toBe('STALE / EXPIRED DATA');
    expect(dialog.textContent).not.toContain('28.50');
    expect(dialog.textContent).not.toContain('Shot');
  });

  it('replaces a removed event and a downgraded tier with the current catalog', async () => {
    await hold(catalog([shotItem()]));
    openTierDetails(pin(shotItem()));
    const dialog = details();
    await hold(catalog([], { revision: 'r2', generated_at: iso(-1) }));
    expect(dialog.querySelector('[data-tier-evidence="missing"]')?.textContent).toBe('This launch is not in the current catalog.');
    expect(dialog.textContent).not.toContain('28.50');
    await hold(catalog([shotItem({ tier: 'watch' })], { revision: 'r3', generated_at: iso(0) }));
    expect(fact(dialog, 'Tier')).toBe('Watch');
    expect(dialog.textContent).not.toContain('Shot');
    expect(dialog.querySelector('[data-tier-track]')?.textContent).toContain('28.50, -80.60');
  });

  it('stops following the catalog after the dialog closes', async () => {
    await hold(catalog([shotItem()]));
    openTierDetails(pin(shotItem()));
    const dialog = details();
    launchCatalog.tick(NOW);
    const text = dialog.textContent;
    dialog.close();
    expect(dialog.isConnected).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(iso(10)));
    launchCatalog.tick(Date.parse(iso(10)));
    expect(dialog.textContent).toBe(text);
    expect(dialog.querySelector('[data-tier-evidence]')).toBeNull();
  });
});
