import assert from 'node:assert/strict';
import test from 'node:test';
import { runContextMatrix } from './context-matrix.mjs';

test('each real context matches its device descriptor', async () => {
  const rows = await runContextMatrix();
  for (const row of rows) console.log(row.text);
  assert.deepEqual(rows.map((row) => row.lifecycle), [
    { opened: 1, closed: 1, live: 0, pending: 0 },
    { opened: 1, closed: 1, live: 0, pending: 0 },
    { opened: 2, closed: 2, live: 0, pending: 0 },
    { opened: 3, closed: 3, live: 0, pending: 0 },
    { opened: 4, closed: 4, live: 0, pending: 0 },
    { opened: 5, closed: 5, live: 0, pending: 0 },
    { opened: 7, closed: 7, live: 0, pending: 0 },
    { opened: 9, closed: 9, live: 0, pending: 0 },
  ]);
  assert.deepEqual(
    rows.map((row) => ({
      label: row.label,
      innerWidth: row.metrics.innerWidth,
      innerHeight: row.metrics.innerHeight,
      devicePixelRatio: row.metrics.devicePixelRatio,
      stillOpen: row.stillOpen ?? false,
    })),
    [
      { label: 'desktop Chrome 1400x900', innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1, stillOpen: false },
      { label: 'WebKit iPhone 13', innerWidth: 390, innerHeight: 664, devicePixelRatio: 3, stillOpen: false },
      { label: 'WebKit iPhone 17 Pro 402x874', innerWidth: 402, innerHeight: 874, devicePixelRatio: 3, stillOpen: false },
      { label: 'WebKit iPhone 17 Pro 874x402', innerWidth: 874, innerHeight: 402, devicePixelRatio: 3, stillOpen: false },
      { label: 'WebKit iPad Pro 11 834x1194', innerWidth: 834, innerHeight: 1194, devicePixelRatio: 2, stillOpen: false },
      { label: 'WebKit 844x390', innerWidth: 844, innerHeight: 390, devicePixelRatio: 3, stillOpen: false },
      { label: 'replace iPhone 17 Pro to 874x402', innerWidth: 874, innerHeight: 402, devicePixelRatio: 3, stillOpen: false },
      { label: 'replace iPhone 13 to 844x390', innerWidth: 844, innerHeight: 390, devicePixelRatio: 3, stillOpen: false },
    ],
  );
});
