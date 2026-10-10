import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
