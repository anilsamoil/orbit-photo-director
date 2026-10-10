import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { SIDE_COLUMN_REACH } from './drive.mjs';
import {
  healthySideColumnSamples,
  laterCascadeMutantSample,
  sideColumnReachVerdict,
  sideColumnTextVerdict,
  statusClipMutantSample,
  textVisibleInPort,
} from './side-column-reach.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const drive = readFileSync(resolve(here, 'drive.mjs'), 'utf8');

test('healthy side-column text samples pass', () => {
  assert.equal(sideColumnReachVerdict(healthySideColumnSamples()).ok, true);
});

test('status-clip mutant fails even when the element box fits the column', () => {
  const sample = statusClipMutantSample();
  assert.equal(sample.elementVisible >= sample.elementBox.height - 1, true);
  const oldBoxOnly = sample.elementVisible >= sample.elementBox.height - 1;
  assert.equal(oldBoxOnly, true);
  const verdict = sideColumnTextVerdict(sample);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.step, 'clipped');
  assert.equal(verdict.reason, 'text');
  assert.equal(verdict.sel, '[data-iss-status]');
  assert.equal(verdict.elementInside, true);
});

test('later-cascade mutant fails on the clipped later selector', () => {
  const samples = laterCascadeMutantSample();
  assert.equal(sideColumnTextVerdict(samples[0]).ok, true);
  const verdict = sideColumnReachVerdict(samples);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.sel, '[data-iss-edition]');
  assert.equal(verdict.reason, 'text');
});

test('textVisibleInPort rejects a rect that crosses the clip edge', () => {
  const port = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  assert.equal(textVisibleInPort([{ left: 0, top: 0, right: 80, bottom: 18, width: 80, height: 18 }], port), true);
  assert.equal(textVisibleInPort([{ left: 0, top: 0, right: 80, bottom: 28, width: 80, height: 28 }], port), false);
});

test('drive SIDE_COLUMN_REACH uses text Range and clip ancestors', () => {
  assert.match(drive, /selectNodeContents/);
  assert.match(drive, /clipPortFor|overflowY/);
  assert.match(drive, /textVisibleInPort|textFits/);
  assert.match(drive, /from '\.\/side-column-reach\.mjs'/);
});

// Scroll-aware geometry doubles exercise the emitted probe, not browser layout.
function sideColumnDOM() {
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const columnTop = 108;
  const scrollWrites = [];
  let column;
  class Element {
    constructor(offset, height, parentElement = null) {
      Object.assign(this, {
        offset, height, parentElement, nodeType: 1, hidden: false,
        left: 8, width: 184, textContent: 'readable',
        style: { overflow: 'visible', overflowX: 'visible', overflowY: 'visible' },
        textLines: [{ offset: 2, height: 13 }],
      });
    }
    getBoundingClientRect() {
      return rect(this.left, columnTop + this.offset - (this.parentElement ? column.scrollTop : 0), this.width, this.height);
    }
    contains(node) {
      for (; node; node = node.parentElement) if (node === this) return true;
      return false;
    }
  }
  column = new Element(0, 186);
  column.left = 0;
  column.width = 200;
  column.style.overflowY = 'auto';
  column.scrollHeight = 600;
  column.clientHeight = column.height;
  let position = 0;
  Object.defineProperty(column, 'scrollTop', {
    get: () => position,
    set: (value) => {
      position = Math.max(0, Math.min(column.scrollHeight - column.clientHeight, value));
      scrollWrites.push(position);
    },
  });
  const scene = new Element(0, 390);
  scene.scrollHeight = scene.clientHeight = 390;
  scene.scrollWidth = scene.clientWidth = 844;
  scene.getAttribute = () => 'on';
  const frame = new Element(0, 185);
  frame.width = 278;
  const elements = new Map([
    ['[data-iss-launch-name]', new Element(0, 20, column)],
    ['[data-iss-launch-visibility]', new Element(25, 20, column)],
    ['[data-iss-houston]', new Element(50, 20, column)],
    ['[data-iss-day-month]', new Element(75, 20, column)],
    ['[data-iss-weekday]', new Element(100, 20, column)],
    ['[data-iss-edition]', new Element(125, 20, column)],
    ['[data-iss-status]', new Element(250, 108, column)],
    ['[data-iss-details] summary', new Element(500, 20, column)],
  ]);
  const status = elements.get('[data-iss-status]');
  status.textLines = Array.from({ length: 6 }, (_, i) => ({ offset: 2 + 18 * i, height: 13 }));
  const summary = elements.get('[data-iss-details] summary');
  summary.textContent = 'Details';
  const details = new Element(summary.offset, summary.height, column);
  summary.parentElement = details;
  details.querySelector = (selector) => selector === 'summary' ? summary : null;
  elements.set('[data-iss-side]', column);
  elements.set('[data-iss-scene]', scene);
  elements.set('[data-iss-frame]', frame);
  elements.set('[data-iss-details]', details);
  elements.set('[data-iss-telemetry]', { getAttribute: () => 'true' });
  const context = {
    HTMLElement: Element,
    getComputedStyle: (el) => el.style,
    document: {
      querySelector: (selector) => elements.get(selector),
      elementFromPoint: (x, y) => {
        const box = summary.getBoundingClientRect();
        return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom ? summary : null;
      },
      createRange: () => {
        let target;
        return {
          selectNodeContents: (el) => { target = el; },
          getClientRects: () => {
            const box = target.getBoundingClientRect();
            return target.textLines.map((line) => rect(box.left, box.top + line.offset, 160, line.height));
          },
        };
      },
    },
  };
  return { column, elements, status, scrollWrites, Element, run: () => runInNewContext(SIDE_COLUMN_REACH, context) };
}

for (const overflow of ['visible', 'hidden']) {
  test(`emitted reach scrolls a fitting ${overflow}-overflow status initially below the column`, () => {
    const dom = sideColumnDOM();
    dom.status.style.overflow = overflow;
    assert.ok(dom.status.getBoundingClientRect().top > dom.column.getBoundingClientRect().bottom);
    assert.ok(dom.status.height < dom.column.clientHeight);
    const result = dom.run();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(dom.scrollWrites.some((position) => position > 0));
    assert.equal(dom.column.scrollTop, 0, 'successful reach restores the column');
  });
}

for (const selector of ['[data-iss-status]', '[data-iss-edition]']) {
  test(`emitted reach rejects 7px clipping on ${selector} despite its fitting element box`, () => {
    const dom = sideColumnDOM();
    const clipped = dom.elements.get(selector);
    clipped.height = 7;
    clipped.style.overflow = 'hidden';
    const result = dom.run();
    assert.equal(result.ok, undefined);
    assert.equal(result.step, 'clipped');
    assert.equal(result.reason, 'text');
    assert.equal(result.sel, selector);
    assert.equal(result.visible, result.height);
  });
}

for (const overflow of ['hidden', 'auto', 'scroll', 'clip']) {
  test(`emitted reach includes nested ${overflow} overflow ancestors when checking text`, () => {
    const dom = sideColumnDOM();
    const ancestor = new dom.Element(dom.status.offset, dom.status.height, dom.column);
    ancestor.width = 70;
    ancestor.style.overflowX = overflow;
    const wrapper = new dom.Element(dom.status.offset, dom.status.height, ancestor);
    dom.status.parentElement = wrapper;
    const result = dom.run();
    assert.equal(result.step, 'clipped');
    assert.equal(result.reason, 'text');
    assert.equal(result.sel, '[data-iss-status]');
    assert.equal(result.visible, result.height);
  });
}

test('emitted reach accepts a tall padded box whose text fits at both fallback alignments', () => {
  const dom = sideColumnDOM();
  dom.status.height = 220;
  dom.status.textLines = [{ offset: 100, height: 13 }];
  const result = dom.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(dom.scrollWrites.includes(250), 'top alignment was exercised');
  assert.ok(dom.scrollWrites.includes(284), 'bottom alignment was exercised');
});

for (const [clippedAt, offset] of [['top', 205], ['bottom', 2]]) {
  test(`emitted reach rejects text clipped at the ${clippedAt} fallback alignment`, () => {
    const dom = sideColumnDOM();
    dom.status.height = 220;
    dom.status.textLines = [{ offset, height: 13 }];
    const result = dom.run();
    assert.equal(result.ok, undefined);
    assert.equal(result.step, 'clipped');
    assert.equal(result.sel, '[data-iss-status]');
    assert.ok(dom.scrollWrites.includes(250), 'top alignment was exercised');
    assert.ok(dom.scrollWrites.includes(284), 'bottom alignment was exercised');
  });
}
