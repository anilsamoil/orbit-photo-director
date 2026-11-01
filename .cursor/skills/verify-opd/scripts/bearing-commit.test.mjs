import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearingCommitFailures, bearingCommitPlan } from './bearing-commit.mjs';

const held = {
  plain: { armed: true, started: true, bearing: 0, writes: [0] },
  zoom: { armed: true, started: true, bearing: 35.3, writes: [] },
  rotate: { armed: true, started: true, bearing: 34.2, writes: [] },
};

test('map-bearing-commit accepts the two created-at-size WebKit surfaces', () => {
  assert.equal(bearingCommitPlan('iphone-17-pro', '402x874').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(bearingCommitPlan('ipad-pro-11', '834x1210').id, 'webkit-ipad-m4-834x1210');
  assert.throws(() => bearingCommitPlan('iphone-17-pro', '874x402'), /one process per surface/);
  assert.throws(() => bearingCommitPlan('ipad-pro-11', '1210x834'), /one process per surface/);
  assert.throws(() => bearingCommitPlan('chrome', '402x874'), /one process per surface/);
  assert.throws(() => bearingCommitPlan('', ''), /one process per surface/);
});

test('a north write after zoomstart or rotatestart is a stale commit', () => {
  assert.deepEqual(bearingCommitFailures(held), []);
  const zoom = bearingCommitFailures({ ...held, zoom: { armed: true, started: true, bearing: 0, writes: [0] } });
  assert.match(zoom.join('\n'), /zoom stale bearing 0/);
  const rotate = bearingCommitFailures({ ...held, rotate: { armed: true, started: true, bearing: 0, writes: [0] } });
  assert.match(rotate.join('\n'), /rotate stale bearing 0/);
  const quiet = bearingCommitFailures({ ...held, plain: { armed: true, started: true, bearing: 40, writes: [] } });
  assert.match(quiet.join('\n'), /plain commit 40/);
  const missed = bearingCommitFailures({ ...held, zoom: { armed: true, started: false, bearing: 35, writes: [] } });
  assert.match(missed.join('\n'), /zoom start did not land/);
});
