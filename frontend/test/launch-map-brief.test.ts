import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMapLaunchBrief } from '../src/launch-map-brief';
import { _setFollowEnvForTest, applyFollowISS, focusLaunchOnMap } from '../src/map';
import { launchStore } from '../src/launch-store';
import { getMapLaunchMode, setMapLaunchMode } from '../src/map-launch-mode';
import { assessment, iso, launch, NOW, state, supported } from './launch-fixtures';

afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem('opd-map-launch-brief-open'); _setFollowEnvForTest(null, false); document.body.replaceChildren(); });

describe('map launch brief', () => {
  it('leads with the next launch and keeps other launches collapsed across refresh', () => {
    const box = document.createElement('div');
    document.body.append(box);
    const show = vi.fn();
    const data = state([launch({ event_id: 'later', launch_window: { ...launch().launch_window, net: new Date(NOW + 3600_000).toISOString() } }), launch()]);
    renderMapLaunchBrief(box, data, NOW, show);
    const primary = box.querySelector<HTMLDetailsElement>('.map-launch-primary')!;
    expect(primary.open).toBe(false);
    expect(primary.querySelector('summary')?.textContent).toBe('Next launch · Chance unknown');
    expect(primary.querySelector('article')?.getAttribute('data-event-id')).toBe('event-1');
    expect(box.firstElementChild?.querySelector('.launch-details .launch-coverage')).not.toBeNull();
    expect(Array.from(box.children).some((child) => child.classList.contains('launch-coverage'))).toBe(false);
    const more = box.querySelector<HTMLDetailsElement>('.map-launch-more')!;
    expect(more.open).toBe(false);
    expect(more.querySelector('summary')?.textContent).toBe('Other launches (1)');
    (box.querySelector('.launch-brief-actions button') as HTMLButtonElement).click();
    expect(show).toHaveBeenCalledWith('event-1');
    more.open = true;
    box.querySelector<HTMLDetailsElement>('.launch-details')!.open = true;
    box.querySelector<HTMLDetailsElement>('.launch-data-details')!.open = true;
    renderMapLaunchBrief(box, data, NOW, show);
    expect(box.querySelector<HTMLDetailsElement>('.map-launch-more')?.open).toBe(true);
    expect(box.querySelector<HTMLDetailsElement>('.launch-details')?.open).toBe(true);
    expect(box.querySelector<HTMLDetailsElement>('.launch-data-details')?.open).toBe(true);
  });
  it('remembers the current choice through an immediate refresh and a new page', () => {
    const box = document.createElement('div');
    document.body.append(box);
    renderMapLaunchBrief(box, state(), NOW, vi.fn());
    const original = box.querySelector<HTMLDetailsElement>('.map-launch-primary')!;
    original.open = true;
    original.querySelector('summary')!.focus();
    // Refresh before the queued native toggle event has fired.
    renderMapLaunchBrief(box, state(), NOW, vi.fn());
    const current = box.querySelector<HTMLDetailsElement>('.map-launch-primary')!;
    expect(current.open).toBe(true);
    expect(document.activeElement).toBe(current.querySelector('summary'));
    const reloaded = document.createElement('div');
    renderMapLaunchBrief(reloaded, state(), NOW, vi.fn());
    expect(reloaded.querySelector<HTMLDetailsElement>('.map-launch-primary')?.open).toBe(true);
    current.open = false;
    current.dispatchEvent(new Event('toggle'));
    original.dispatchEvent(new Event('toggle')); // Detached old events cannot reopen it.
    renderMapLaunchBrief(document.createElement('div'), state(), NOW, vi.fn());
    expect(localStorage.getItem('opd-map-launch-brief-open')).toBe('0');
    renderMapLaunchBrief(box, state(), NOW, vi.fn());
    expect(box.querySelector<HTMLDetailsElement>('.map-launch-primary')?.open).toBe(false);
  });
  it('keeps the current choice through missing data and storage failure', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    const box = document.createElement('div');
    renderMapLaunchBrief(box, state(), NOW, vi.fn());
    const primary = box.querySelector<HTMLDetailsElement>('.map-launch-primary')!;
    expect(primary.open).toBe(false);
    primary.open = true;
    renderMapLaunchBrief(box, state([], { artifact: null, availability: 'loading' }), NOW, vi.fn());
    renderMapLaunchBrief(box, state(), NOW, vi.fn());
    expect(box.querySelector<HTMLDetailsElement>('.map-launch-primary')?.open).toBe(true);
  });
  it('updates the collapsed verdict without reopening or retaining a superseded green', () => {
    const box = document.createElement('div');
    const items = [launch({ assessment: assessment() })];
    renderMapLaunchBrief(box, state(items), NOW, vi.fn());
    expect(box.querySelector('.map-launch-primary > summary')?.textContent).toContain('Possible at liftoff');
    expect(box.querySelector('.map-launch-primary > summary')?.getAttribute('data-has-chance')).toBe('true');
    renderMapLaunchBrief(box, state(items, { superseded: true }), NOW, vi.fn());
    expect(box.querySelector<HTMLDetailsElement>('.map-launch-primary')?.open).toBe(false);
    expect(box.querySelector('.map-launch-primary > summary')?.getAttribute('data-has-chance')).toBe('false');
    expect(box.querySelector('.map-launch-primary > summary')?.textContent).not.toContain('Possible at liftoff');
  });
  it('describes an unavailable schedule without claiming no launches exist', () => {
    const box = document.createElement('div');
    renderMapLaunchBrief(box, state([], { artifact: null, availability: 'offline' }), NOW, vi.fn());
    expect(box.querySelector('p')?.textContent).toContain('schedule unavailable');
    expect(box.querySelector('article')).toBeNull();
  });
  it('signals a later possible shot even while other launch cards are collapsed', () => {
    const box = document.createElement('div');
    const later = launch({ event_id: 'possible-later', launch_window: { net: iso(60), start: iso(60), end: iso(61), precision: 'Minute' },
      assessment: assessment({ net: { ...assessment().net, at: iso(60) } }) });
    renderMapLaunchBrief(box, state([launch(), later]), NOW, vi.fn());
    expect(box.querySelector('.map-launch-more summary')?.textContent).toBe('Other launches (1) · 1 possible');
    expect(box.querySelector<HTMLDetailsElement>('.map-launch-more')?.open).toBe(false);
  });
});

describe('show launch on map', () => {
  afterEach(() => setMapLaunchMode(false));
  function setup(data = state()) {
    setMapLaunchMode(false);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(launchStore, 'getState').mockReturnValue(data);
    const map = { setCenter: vi.fn(), easeTo: vi.fn(), fitBounds: vi.fn(), hasLayer: vi.fn(() => true), visibilityOf: vi.fn(), setVisibility: vi.fn() };
    _setFollowEnvForTest(map, true);
    document.body.innerHTML = '<button id="toggle-follow-iss"></button>';
    return map;
  }
  it('shows an unknown-trajectory pad and releases ISS following without fabricating a corridor', () => {
    const map = setup();
    expect(focusLaunchOnMap('event-1')).toBe(true);
    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-80.6, 28.5] }));
    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(getMapLaunchMode()).toBe(true);
    expect(map.setVisibility).toHaveBeenCalledWith('ascent-pad-layer', 'visible');
    applyFollowISS({ lat: 0, lon: 0 });
    expect(map.setCenter).not.toHaveBeenCalled();
  });
  it('fits a supplied dateline corridor as a short crossing', () => {
    const item = supported({ site: { name: 'Dateline test', lon: 179, lat: 0 }, trajectory: {
      quality: 'verified', source: 'Synthetic mission', points: [
        { lon: 179, lat: 0, alt_km: 0, t_offset_seconds: 0 },
        { lon: -179, lat: 1, alt_km: 50, t_offset_seconds: 60 },
      ],
    } });
    const map = setup(state([item]));
    expect(focusLaunchOnMap(item.event_id)).toBe(true);
    const bounds = map.fitBounds.mock.calls[0]![0];
    expect(bounds.east - bounds.west).toBe(2);
    expect(map.easeTo).not.toHaveBeenCalled();
  });
  it('ignores events removed by a newer revision', () => {
    const map = setup(state([]));
    expect(focusLaunchOnMap('event-1')).toBe(false);
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(getMapLaunchMode()).toBe(false);
  });
});
