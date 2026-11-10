import assert from 'node:assert/strict';
import { test } from 'node:test';
import { narrowPlacementViolations } from './census-narrow-chrome.mjs';

test('permits measuring scrolled content without changing its scroll position', () => {
  assert.deepEqual(narrowPlacementViolations('', 'const contentBottom = rect.bottom + panel.scrollTop;'), []);
});

test('rejects scroll writes, increments, and scrolling methods', () => {
  for (const source of ['panel.scrollTop = 0;', 'dock.scrollLeft += 1;', 'panel.scrollTop++;', '--dock.scrollLeft;', 'panel.scrollTo(0, 0);', 'panel.scrollBy(0, 1);', 'panel.scroll(0, 0);']) {
    assert.deepEqual(narrowPlacementViolations('', source), ['map-chrome.ts writes a scroll offset'], source);
  }
});

test('still rejects a second narrow chrome positioner', () => {
  assert.equal(narrowPlacementViolations('@media (max-width: 719px) { .map-control-dock { left: 0; } }').length, 1);
});

test('permits the banner copy to scroll inside its measured footer', () => {
  assert.deepEqual(narrowPlacementViolations('@media (max-width: 719px) { #status-banner .banner-copy { min-width: 0; max-height: 44px; overflow-y: auto; } }'), []);
});

test('still rejects placement of the footer and its copy', () => {
  for (const selector of ['#status-banner', '#status-banner .banner-copy', '#status-banner .banner-copy, .map-control-dock']) {
    assert.equal(narrowPlacementViolations(`@media (max-width: 719px) { ${selector} { left: 0; } }`).length, 1);
  }
  assert.equal(narrowPlacementViolations('@media (max-width: 719px) { #status-banner { max-height: 44px; } }').length, 1);
  assert.equal(narrowPlacementViolations('@media (max-width: 719px) { .map-control-dock, #status-banner .banner-copy { max-height: 44px; } }').length, 1);
});
