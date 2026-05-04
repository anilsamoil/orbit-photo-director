import { describe, expect, it } from 'vitest';

import { createIssMarkerElement } from '../src/map';

describe('createIssMarkerElement', () => {
  it('returns a div with the iss-marker class', () => {
    const el = createIssMarkerElement();
    expect(el.tagName).toBe('DIV');
    expect(el.classList.contains('iss-marker')).toBe(true);
  });

  it('contains a pulse element for the animated halo', () => {
    const el = createIssMarkerElement();
    expect(el.querySelector('.iss-pulse')).toBeTruthy();
  });

  it('contains an SVG with the correct viewBox', () => {
    const el = createIssMarkerElement();
    const svg = el.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('viewBox')).toBe('-20 -8 40 16');
  });

  it('renders both solar arrays (left + right) and a central truss', () => {
    const el = createIssMarkerElement();
    const rects = el.querySelectorAll('rect');
    // 2 solar arrays + 1 truss = 3 rects
    expect(rects.length).toBe(3);
    const xs = Array.from(rects).map((r) => Number(r.getAttribute('x')));
    expect(xs).toContain(-18); // port array
    expect(xs).toContain(4);   // starboard array
    expect(xs).toContain(-3);  // truss
  });

  it('exposes role + aria-label so screen readers announce the marker', () => {
    const el = createIssMarkerElement();
    const svg = el.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toContain('ISS');
  });

  it('uses a high-contrast white truss on a cyan panel ground', () => {
    const el = createIssMarkerElement();
    const trussRect = Array.from(el.querySelectorAll('rect')).find(
      (r) => r.getAttribute('x') === '-3',
    );
    expect(trussRect?.getAttribute('fill')).toBe('#ffffff');
  });
});
