import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindHelp, openHelpModal, syncHelpButton } from '../src/help';

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

  it('lists the six tabs with ISS view after Map', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    for (const tab of ['Queue', 'Upcoming', 'Map', 'ISS view', 'Profile', 'Log']) {
      expect(text).toContain(tab);
    }
    const map = text.indexOf('Map');
    const iss = text.indexOf('ISS view');
    const profile = text.indexOf('Profile');
    expect(map).toBeGreaterThanOrEqual(0);
    expect(iss).toBeGreaterThan(map);
    expect(profile).toBeGreaterThan(iss);
  });

  it('describes ISS aiming and the pad look, and does not bring Reset back', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    const aiming = text.slice(text.indexOf('Aiming the ISS view'), text.indexOf('Reading a pass card'));
    expect(aiming).toContain('Horizon');
    expect(aiming).toContain('keep a pinched field');
    expect(aiming).toContain('n / N');
    expect(aiming).toContain('W, A, S, and D');
    expect(aiming).toContain('Hold Shift');
    expect(aiming).toContain('Pinch or scroll');
    expect(aiming).toContain('Window 7');
    expect(aiming).toContain('14 mm lens');
    expect(aiming).toContain('#iss=');
    expect(aiming).toContain('beside Telemetry');
    expect(aiming).toContain('All launches');
    expect(aiming).toContain('14 days');
    expect(aiming).toContain('Map and Upcoming list chances only');
    expect(aiming).toContain('None clears it.');
    expect(aiming).not.toContain('possible shot');
    expect(aiming).toContain('about 18°');
    expect(aiming).toContain('gold pin');
    expect(aiming).toContain('arrow on the edge');
    expect(aiming).toContain('on the Earth but outside the picture');
    expect(aiming).toContain('only when that launch includes a trajectory');
    expect(aiming).not.toMatch(/Reset/);
    expect(aiming.toLowerCase()).not.toContain('double-tap');
    expect(aiming).not.toMatch(/S (selects|means|is) straight down/i);
    expect(text).not.toContain('Horizon opens first');
    expect(text).not.toMatch(/Reset/);
    expect(text.toLowerCase()).not.toContain('double-tap');
  });

  it('names the legend states, the footer recovery, and the Safari data clear', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    expect(text).toContain('launch, day, twilight, and eclipse');
    expect(text).toContain('Anil\'s targets, Starship, and your white rings are not rows');
    expect(text).toContain('Starship is not a legend row');
    expect(text).toContain('Tap Legend on the left edge');
    expect(text).toContain('shows only while the legend is open');
    expect(text).toContain('A live IR warning adds a mark on Legend');
    expect(text).not.toContain('Starship: no public orbit yet');
    expect(text).not.toContain('Starship: public orbit expired');
    expect(text).not.toContain('Starship: orbit lookup failed');
    expect(text).toContain('Sign in and Reload are in that footer');
    expect(text).toContain('Settings > Apps > Safari > Advanced > Website Data');
    expect(text).toContain('remove astroanil');
    expect(text).toContain('live track expired');
  });

  it('explains the score, the zoom preview, and photo lookup', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    expect(text).toContain('Score');
    expect(text).toContain('Zoom preview');
    expect(text.toLowerCase()).toContain('exif');
  });

  it('covers the calendar reminder alarm (5 min before + at pass)', () => {
    openHelpModal();
    const text = (document.querySelector('.help-body')?.textContent ?? '').toLowerCase();
    expect(text).toContain('add to calendar');
    expect(text).toContain('5 minutes before');
    expect(text).toContain('closest approach');
  });

  it('covers the look angle/distance and the WORF/Cupola window', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    expect(text).toContain('off-nadir');
    expect(text).toContain('right of track');
    expect(text).toContain('WORF');
    expect(text).toContain('Cupola');
    expect(text).toContain('Nadir distance');
  });

  it('explains the time slider and scrub behavior', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    expect(text).toContain('Time slider');
    expect(text).toContain('36 hours');
    expect(text).toContain('not forecast');
    expect(text).toContain('stale TLE');
  });

  it('explains dropping a pin on the map', () => {
    openHelpModal();
    const text = (document.querySelector('.help-body')?.textContent ?? '').toLowerCase();
    expect(text).toContain('long-press');
    expect(text).toContain('right-click');
  });

  it('explains tapping a target pin', () => {
    openHelpModal();
    const text = (document.querySelector('.help-body')?.textContent ?? '').toLowerCase();
    expect(text).toContain('tap a target');
    expect(text).toContain('off the ground');
    expect(text).toContain('no upcoming pass');
    expect(text).toContain('nearest one to');
  });

  it('explains editing a target', () => {
    openHelpModal();
    const text = (document.querySelector('.help-body')?.textContent ?? '').toLowerCase();
    expect(text).toContain('edit a target');
    expect(text).toContain('edit target');
    expect(text).toContain('curated targets have no edit button');
    expect(text).toContain('two devices');
  });

  it('describes offline caching behavior', () => {
    openHelpModal();
    const text = (document.querySelector('.help-body')?.textContent ?? '').toLowerCase();
    expect(text).toContain('offline');
    expect(text).toContain('cache');
    expect(text).toContain('black');
  });

  it('explains the token, shoot, and hide controls', () => {
    openHelpModal();
    const text = document.querySelector('.help-body')?.textContent ?? '';
    expect(text).toContain('Shoot');
    expect(text).toContain('Hide');
    expect(text).toContain('calibration token');
  });

  it('explains the inline star rating after Shoot', () => {
    openHelpModal();
    const text = (document.querySelector('.help-body')?.textContent ?? '').toLowerCase();
    expect(text).toContain('star');
    expect(text).toContain("how'd it come out");
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

  it('hides the corner button on the map and the ISS view, and shows it on the other views', () => {
    document.body.innerHTML = `
      <main id="view" class="view-map"></main>
      <button id="help-fab" type="button">?</button>
    `;
    syncHelpButton();
    const fab = document.getElementById('help-fab') as HTMLButtonElement;
    expect(fab.hidden).toBe(true);
    document.getElementById('view')!.className = 'view-queue';
    syncHelpButton();
    expect(fab.hidden).toBe(false);
    document.getElementById('view')!.className = 'view-iss';
    syncHelpButton();
    expect(fab.hidden).toBe(true);
    for (const view of ['view-upcoming', 'view-profile', 'view-log']) {
      document.getElementById('view')!.className = view;
      syncHelpButton();
      expect(fab.hidden).toBe(false);
    }
  });
});

describe('Photography Almanac anchors (Unit 1)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('the almanac section renders with the camera entry carrying its anchor id', () => {
    openHelpModal();
    const titles = [...document.querySelectorAll('.help-section-title')]
      .map((h) => h.textContent);
    expect(titles).toContain('Photography Almanac');
    const entry = document.getElementById('help-almanac-camera');
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain('HAND-TRACKING');
    expect(entry!.textContent).toContain('Pettit');
  });

  it('openHelpModal(anchor) scrolls the entry into view on a fresh open', () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as never;
    openHelpModal('almanac-camera');
    expect(spy).toHaveBeenCalledWith({ block: 'start' });
  });

  it('already-open modal: a second anchored call scrolls instead of stacking', () => {
    openHelpModal();
    expect(document.querySelectorAll('.help-modal')).toHaveLength(1);
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as never;
    openHelpModal('almanac-camera');
    expect(document.querySelectorAll('.help-modal')).toHaveLength(1); // no stack
    expect(spy).toHaveBeenCalledWith({ block: 'start' });
  });

  it('a missing anchor opens the modal at the top without throwing (graceful)', () => {
    expect(() => openHelpModal('almanac-does-not-exist')).not.toThrow();
    expect(document.querySelector('.help-modal')).not.toBeNull();
  });
});

describe('Photography Almanac completion (Unit 8)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const entryText = (anchor: string): string => {
    openHelpModal();
    return document.getElementById(`help-${anchor}`)?.textContent ?? '';
  };

  it('renders all twelve almanac entries, each carrying its anchor id', () => {
    openHelpModal();
    const ids = [
      'almanac-intro', 'almanac-camera', 'almanac-sprites', 'almanac-glint',
      'almanac-nlc', 'almanac-golden-hour', 'almanac-aurora', 'almanac-night-sky',
      'almanac-cities-night', 'almanac-meteors', 'almanac-moon', 'almanac-beta',
    ];
    for (const id of ids) {
      expect(document.getElementById(`help-${id}`), id).not.toBeNull();
    }
  });

  it('the intro categorizes aurora as a topbar cue, NOT a pass row, and counts five rows', () => {
    // The adversarial verifier caught a draft that miscounted aurora as a
    // sixth pass row; aurora is NOT in the PROVIDERS registry. Guard the fix.
    const t = entryText('almanac-intro');
    expect(t).toContain('Five subjects get a live per-pass row');
    expect(t).toContain('Aurora has its own topbar cue');
    expect(t).toContain('not a pass row');
    // It must not claim six rows or list aurora among the per-pass subjects.
    expect(t).not.toContain('Six subjects');
    // Cities are NOT dark-sky-only (Codex fix): Moon-tolerant + Night-lights
    // overlay is their cue, so they must not be lumped with the faint pair.
    expect(t).toContain('Moon-tolerant');
    expect(t).toContain('Night-lights map overlay');
  });

  it('aurora entry ties to the real Kp/OVATION feature with verbatim Pettit settings', () => {
    const t = entryText('almanac-aurora');
    expect(t).toContain('Kp');
    expect(t).toContain('OVATION');
    expect(t).toContain('(moonlit — faint)');  // honors the moon gate
    expect(t).toContain('ISO 3200, 1/2s');      // verbatim Aurora card
    // Must NOT over-claim "the one ... actively watches" (Codex fix): sprites
    // are actively watched per-pass too. Aurora is the TOPBAR watch.
    expect(t).toContain('watches from the topbar');
    expect(t).not.toContain('the one night subject');
  });

  it('night-sky entry covers stars/Milky Way/airglow as reference, no row', () => {
    const t = entryText('almanac-night-sky');
    expect(t).toContain('Milky Way');
    expect(t).toContain('airglow');
    expect(t.replace(/\s+/g, ' ')).toContain('no dedicated star or airglow row');
    expect(t).toContain('ISO 6400');  // verbatim Night Phenomena card
  });

  it('cities entry is honest about having no condition row + verbatim settings', () => {
    const t = entryText('almanac-cities-night').replace(/\s+/g, ' ');
    expect(t).toContain('no city-specific condition row');
    expect(t).toContain('ISO 6400 at 1/60s');   // verbatim Cities at Night card
    // Exposure-limited, NOT motion-floor-limited (Codex fix): a night city
    // holds Pettit's slow shutter + loose-Bogen, it does not chase the
    // daylit camera-line motion floor.
    expect(t).toContain('exposure-limited');
    expect(t).toContain('loose Bogen hand-track');
  });

  it('meteors entry is reference-only with the verbatim 15s/ISO800 ladder', () => {
    const t = entryText('almanac-meteors').replace(/\s+/g, ' ');
    expect(t).toContain('no dedicated meteor row');
    expect(t).toContain('ISO 800 at 15s');       // verbatim Meteor Showers card
    expect(t).toContain('intervalometer');
  });

  it('every new entry deep-links: openHelpModal(anchor) scrolls it into view', () => {
    for (const anchor of ['almanac-aurora', 'almanac-night-sky',
      'almanac-cities-night', 'almanac-meteors', 'almanac-intro']) {
      document.body.innerHTML = '';
      const spy = vi.fn();
      Element.prototype.scrollIntoView = spy as never;
      openHelpModal(anchor);
      expect(spy, anchor).toHaveBeenCalledWith({ block: 'start' });
    }
  });
});

describe('condition-row → almanac deep-link contract (Unit 9 integration)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // Every almanacAnchor a condition-row provider (Units 1-7) can emit MUST
  // resolve to a real almanac entry (Unit 8), or the row's tap silently opens
  // the help modal at the top instead of the matching card. This is the seam
  // between the providers and the almanac — guard it so neither side can
  // drift (rename an entry id, add a provider with a typo'd anchor) unnoticed.
  // Kept in sync with the `almanacAnchor:` literals in photo-conditions.ts.
  const PROVIDER_ANCHORS = [
    'almanac-camera',       // cameraConditionProvider (Unit 1)
    'almanac-beta',         // betaBlackoutProvider (Unit 2)
    'almanac-moon',         // moonConditionProvider (Unit 3)
    'almanac-golden-hour',  // goldenHourConditionProvider (Unit 4)
    'almanac-nlc',          // nlcConditionProvider (Unit 5)
    'almanac-glint',        // glintConditionProvider (Unit 6)
    'almanac-sprites',      // spriteConditionProvider (Unit 7)
  ];

  it('every provider almanac anchor resolves to a help entry', () => {
    openHelpModal();
    for (const anchor of PROVIDER_ANCHORS) {
      expect(document.getElementById(`help-${anchor}`), anchor).not.toBeNull();
    }
  });

  it('each provider anchor deep-links (scrolls its card into view)', () => {
    for (const anchor of PROVIDER_ANCHORS) {
      document.body.innerHTML = '';
      const spy = vi.fn();
      Element.prototype.scrollIntoView = spy as never;
      openHelpModal(anchor);
      expect(spy, anchor).toHaveBeenCalledWith({ block: 'start' });
    }
  });
});
