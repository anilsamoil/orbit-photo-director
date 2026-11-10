import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHOT_FORECAST_MS, forecastEdgeClock } from './fixtures.mjs';
import { launchShotForecastFailures, launchShotForecastPlan } from './launch-shot-forecast.mjs';

const passed = {
  plainSummary: 'Next launch · Shot',
  plainLabel: 'LAUNCH / SHOT',
  forecastSummary: 'Next launch · Shot (forecast)',
  forecastLabel: 'Shot (forecast)',
  mark: 1,
  tickMs: 1100,
};

test('launch-shot-forecast accepts the three created-at-size surfaces', () => {
  assert.equal(launchShotForecastPlan('desktop', '1440x900').id, 'chrome-1440x900');
  assert.equal(launchShotForecastPlan('iphone-17-pro', '402x874').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(launchShotForecastPlan('ipad-pro-11', '834x1210').id, 'webkit-ipad-m4-834x1210');
  assert.throws(() => launchShotForecastPlan('iphone-17-pro', '874x402'), /one process per surface/);
  assert.throws(() => launchShotForecastPlan('desktop', '1280x800'), /one process per surface/);
});

test('the forecast edge lease straddles the 48 hour boundary by one second', () => {
  const clock = forecastEdgeClock(Date.parse('2026-10-26T12:00:00.400Z'));
  assert.equal(clock.boundary, Date.parse('2026-10-26T12:00:00.000Z'));
  assert.equal(clock.liftoff - clock.boundary, SHOT_FORECAST_MS);
  assert.equal(clock.liftoff - clock.plain, SHOT_FORECAST_MS + 1000);
  assert.equal(clock.liftoff - clock.forecast, SHOT_FORECAST_MS - 1000);
  assert.ok(clock.generated <= clock.plain && clock.forecast < clock.geometry);
  assert.ok(clock.forecast < clock.schedule);
  assert.equal(clock.geometry - clock.generated, 14 * 60_000);
});

test('a missing forecast flip fails the sample', () => {
  assert.deepEqual(launchShotForecastFailures(passed), []);
  const stuck = launchShotForecastFailures({ ...passed, forecastSummary: 'Next launch · Shot', forecastLabel: 'LAUNCH / SHOT' });
  assert.match(stuck.join('\n'), /forecast summary/);
  assert.match(launchShotForecastFailures({ ...passed, plainLabel: null }).join('\n'), /plain label/);
  assert.match(launchShotForecastFailures({ ...passed, mark: 0 }).join('\n'), /reloaded/);
});
