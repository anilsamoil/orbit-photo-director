import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(process.env.OPD_VERIFY_RESTORE_SOURCE || new URL('./drive.mjs', import.meta.url), 'utf8');
const aim = { mode: 'horizon', windowId: null, azimuthDeg: 0, opticalFovDeg: 81.2, look: { rightDeg: 5, upDeg: 0 } };
const stored = { raw: JSON.stringify(aim), lat: 10, lng: 20 };
const origin = { lat: 10, lng: 19 };

function expression(functionName, step) {
  const functionStart = source.indexOf(`async function ${functionName}(`);
  assert.notEqual(functionStart, -1, functionName);
  const stepStart = source.indexOf(`'${step}'`, functionStart);
  assert.notEqual(stepStart, -1, step);
  const start = source.lastIndexOf('`(() => {', stepStart);
  const end = source.indexOf('})()`', start) + '})()`'.length;
  assert.ok(start > functionStart && end < stepStart, 'the test must execute the drive wait expression');
  return runInNewContext(source.slice(start, end), {
    aim, stored, origin, narrowed: { fov: 40 }, windowMismatch: "cupola.value !== '' || !chip.hidden",
  });
}

const keyboard = expression('proveIssKeyboard', 'iss fov label before key');
const restore = expression('proveIssAimLink', 'iss aim restored from the link');
const optical = expression('proveIssOpticalFov', 'iss fov ready');
const reloaded = expression('proveIssAimReload', 'iss aim restored after reload');

function run(probe, overrides = {}) {
  const sample = {
    phase: 'running', state: 'live', text: '81.2°', center: { lat: 10, lng: 20 }, fov: 81.2, roll: 180,
    ...overrides,
  };
  const elements = {
    '[data-iss-scene]': { getAttribute: () => sample.phase },
    '[data-iss-fov]': sample.labelMissing ? null : { getAttribute: () => sample.state, textContent: sample.text },
    '[data-iss-preset="horizon"]': { getAttribute: () => 'true' },
    '[data-iss-preset="nadir"]': { getAttribute: () => 'false' },
    '[data-iss-cupola]': { value: '' },
    '[data-iss-window]': { hidden: true },
    '[data-iss-frame]': { getBoundingClientRect: () => ({ width: 300, height: 200, left: 0, top: 0 }) },
  };
  return runInNewContext(probe, {
    URLSearchParams,
    location: { search: '?e2e', hash: `#${new URLSearchParams({ iss: stored.raw })}` },
    document: { getElementById: () => ({ className: 'view-iss' }), querySelector: (selector) => elements[selector] },
    window: {
      __opdIss: { getCenter: () => sample.center, getVerticalFieldOfView: () => sample.fov, getRoll: () => sample.roll, getZoom: () => 2 },
      __opdFovWatch: sample.badWatch ? { bad: sample.badWatch } : null,
    },
  });
}

test('link restore accepts a finite running/live camera that matches the stored aim', () => {
  assert.equal(run(restore).ok, true);
});

function runReload(overrides = {}) {
  const sample = {
    fov: 40,
    raw: '{"windowId":3}',
    phase: 'running',
    state: 'live',
    roll: 180,
    center: { lat: 10, lng: 20 },
    text: undefined,
    ...overrides,
  };
  if (sample.text === undefined) {
    sample.text = typeof sample.fov === 'number' && Number.isFinite(sample.fov) ? `${sample.fov.toFixed(1)}°` : '';
  }
  const elements = {
    '[data-iss-window]': sample.chipMissing ? null : { hidden: false, textContent: 'W3' },
    '[data-iss-cupola]': { value: '3' },
    '[data-iss-preset="horizon"]': { getAttribute: () => 'false' },
    '[data-iss-scene]': sample.sceneMissing ? null : { getAttribute: () => sample.phase },
    '[data-iss-fov]': sample.labelMissing ? null : { getAttribute: () => sample.state, textContent: sample.text },
  };
  const map = sample.mapMissing ? null : {
    getVerticalFieldOfView: () => sample.fov,
    getCenter: () => sample.center,
    getRoll: () => sample.roll,
  };
  return runInNewContext(reloaded, {
    document: {
      getElementById: () => ({ className: 'view-iss' }),
      querySelector: (selector) => elements[selector] ?? null,
    },
    window: { __opdIss: map },
    sessionStorage: { getItem: () => sample.raw },
    localStorage: { getItem: (key) => key === 'opd-iss-aim' ? sample.raw : null },
  });
}

test('reload restore accepts the stored finite field', () => {
  assert.equal(runReload().ok, true);
  assert.equal(runReload({ fov: 40.4 }).ok, true);
});

for (const fov of [NaN, Infinity, -Infinity]) {
  test(`reload restore rejects nonfinite field ${fov}`, () => {
    assert.throws(() => runReload({ fov }), /iss aim restore field is NaN/);
  });
}

for (const overrides of [{ fov: undefined }, { fov: 40.6 }, { mapMissing: true }, { raw: null }, { chipMissing: true }]) {
  test(`reload restore keeps waiting for incomplete sample ${JSON.stringify(overrides)}`, () => {
    assert.equal(runReload(overrides), null);
  });
}

const reloadRejects = [
  ['phase error', { phase: 'error' }, /iss aim restore is in error/],
  ['phase blank', { phase: '' }, null],
  ['phase loading', { phase: 'loading' }, null],
  ['phase paused', { phase: 'paused' }, null],
  ['phase suspended', { phase: 'suspended' }, null],
  ['readout pending', { state: 'pending' }, null],
  ['readout blank', { state: '' }, null],
  ['readout error', { state: 'error' }, /iss aim restore fov state/],
  ['readout stale', { state: 'stale' }, /iss aim restore fov state/],
  ['readout not a field', { text: 'not a field' }, /iss aim restore label is NaN/],
  ['center missing', { center: null }, /iss aim restore center is NaN/],
  ['center NaN latitude', { center: { lat: NaN, lng: 20 } }, /iss aim restore center is NaN/],
  ['center NaN longitude', { center: { lat: 10, lng: NaN } }, /iss aim restore center is NaN/],
  ['center infinite latitude', { center: { lat: Infinity, lng: 20 } }, /iss aim restore center is NaN/],
  ['roll NaN', { roll: NaN }, /iss aim restore roll is NaN/],
  ['roll Infinity', { roll: Infinity }, /iss aim restore roll is NaN/],
  ['roll 0', { roll: 0 }, null],
];
assert.equal(reloadRejects.length, 17);

for (const [engine, probe] of [
  ['reload', (overrides) => runReload(overrides)],
  ['link', (overrides) => run(restore, overrides)],
]) {
  for (const [name, overrides, error] of reloadRejects) {
    test(`${engine} restore rejects ${name} while the field matches`, () => {
      const result = () => probe(overrides);
      if (error) assert.throws(result, error);
      else assert.equal(result(), null);
    });
  }
}

test('reload restore does not widen the half-degree field tolerance', () => {
  assert.equal(runReload({ fov: 60 }), null);
});

test('link restore checks the current roll on every observation', () => {
  assert.equal(run(restore, { roll: 180 }).ok, true);
  assert.equal(run(restore, { roll: 0 }), null);
  assert.throws(() => run(restore, { roll: NaN }), /iss aim restore roll is NaN/);
  assert.equal(run(restore, { roll: 180 }).ok, true);
});

for (const phase of ['', 'loading', 'paused']) {
  test(`link restore waits for running instead of accepting phase ${JSON.stringify(phase)}`, () => {
    assert.equal(run(restore, { phase }), null);
  });
}

test('link restore reports an error phase immediately', () => {
  assert.throws(() => run(restore, { phase: 'error' }), /iss aim restore is in error/);
});

for (const state of ['', 'pending']) {
  test(`link restore waits for live instead of accepting state ${JSON.stringify(state)}`, () => {
    assert.equal(run(restore, { state }), null);
  });
}

for (const state of ['error', 'stale']) {
  test(`link restore rejects unexpected readout state ${state}`, () => {
    assert.throws(() => run(restore, { state }), /iss aim restore fov state/);
  });
}

for (const [name, center] of [['missing', null], ['NaN latitude', { lat: NaN, lng: 20 }], ['NaN longitude', { lat: 10, lng: NaN }], ['infinite latitude', { lat: Infinity, lng: 20 }]]) {
  test(`link restore rejects invalid center ${name}`, () => {
    assert.throws(() => run(restore, { center }), /iss aim restore center is NaN/);
  });
}

for (const fov of [NaN, Infinity, -Infinity]) {
  test(`link restore rejects invalid camera field ${fov}`, () => {
    assert.throws(() => run(restore, { fov }), /iss aim restore field is NaN/);
  });
}

test('link restore reports a nonnumeric live readout immediately', () => {
  assert.throws(() => run(restore, { text: 'not a field' }), /iss aim restore label is NaN/);
});

for (const overrides of [{ labelMissing: true }, { text: '' }, { text: '  ' }, { fov: 84 }, { text: '80°' }, { center: { lat: 12, lng: 20 } }, { center: origin }]) {
  test(`link restore keeps waiting for incomplete or mismatched sample ${JSON.stringify(overrides)}`, () => {
    assert.equal(run(restore, overrides), null);
  });
}

for (const roll of [180, -180, 540, 179.6, 180.4]) {
  test(`link restore accepts applied roll ${roll}`, () => {
    assert.equal(run(restore, { roll }).ok, true);
  });
}

for (const roll of [0, 179, 181]) {
  test(`link restore waits for incorrect roll ${roll}`, () => {
    assert.equal(run(restore, { roll }), null);
  });
}

for (const roll of [NaN, Infinity, -Infinity]) {
  test(`link restore rejects nonfinite roll ${roll}`, () => {
    assert.throws(() => run(restore, { roll }), /iss aim restore roll is NaN/);
  });
}

for (const roll of [180, -180, 540, 179.6, 180.4]) {
  test(`keyboard readiness accepts applied roll ${roll}`, () => {
    assert.equal(run(keyboard, { roll }).ok, true);
  });
}

for (const roll of [0, 179, 181]) {
  test(`keyboard readiness waits for incorrect roll ${roll}`, () => {
    assert.equal(run(keyboard, { roll }), null);
  });
}

for (const roll of [NaN, Infinity, -Infinity]) {
  test(`keyboard readiness rejects nonfinite roll ${roll}`, () => {
    assert.throws(() => run(keyboard, { roll }), /iss roll is NaN/);
  });
}

for (const roll of [180, -180, 540, 179.6, 180.4]) {
  test(`optical readiness accepts applied roll ${roll}`, () => {
    assert.equal(run(optical, { roll }).ok, true);
  });
}

for (const roll of [NaN, Infinity, -Infinity, 0]) {
  test(`optical readiness rejects a live readout with invalid roll ${roll}`, () => {
    assert.throws(() => run(optical, { roll }), /live fov does not match the camera/);
  });
}

test('optical readiness waits for the first live readout', () => {
  assert.equal(run(optical, { state: 'pending', text: '', roll: 0 }), null);
});

for (const [name, probe] of [['keyboard', keyboard], ['link restore', restore], ['optical', optical]]) {
  test(`first-live camera violation fails ${name}`, () => {
    assert.throws(() => run(probe, { badWatch: { roll: 0 } }), /live fov before the camera/);
  });
}
