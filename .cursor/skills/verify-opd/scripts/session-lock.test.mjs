import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bannerTurnFailures,
  profileLockFailures,
  profileReadyFailures,
  queueRecoveryFailures,
  sessionLockPlan,
} from './session-lock.mjs';

test('session-lock accepts the two created-at-size WebKit surfaces', () => {
  assert.equal(sessionLockPlan('iphone-17-pro', '402x874', 'banner').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(sessionLockPlan('ipad-pro-11', '834x1210', 'queue').id, 'webkit-ipad-m4-834x1210');
  assert.equal(sessionLockPlan('iphone-17-pro', '402x874', 'profile').lock, 'profile');
  assert.throws(() => sessionLockPlan('iphone-17-pro', '874x402', 'banner'), /one process per surface/);
  assert.throws(() => sessionLockPlan('ipad-pro-11', '1210x834', 'profile'), /one process per surface/);
  assert.throws(() => sessionLockPlan('desktop', '1440x900', 'queue'), /one process per surface/);
  assert.throws(() => sessionLockPlan('iphone-17-pro', '402x874', ''), /one process per surface/);
});

test('the network banner is present inside the first timeout', () => {
  assert.deepEqual(bannerTurnFailures({
    coldTurn: true,
    bannerAtTurn: true,
    text: 'Load failed',
    signIn: 'Sign in',
    reload: 'Reload',
    cards: 0,
  }), []);
  assert.match(bannerTurnFailures({
    coldTurn: true,
    bannerAtTurn: false,
    text: 'Load failed',
    signIn: 'Sign in',
    reload: 'Reload',
    cards: 0,
  }).join('\n'), /setTimeout\(0\)/);
});

test('a denied session keeps Queue and locks Profile', () => {
  assert.deepEqual(queueRecoveryFailures({
    text: 'Please sign in again to open your own profile. Your saved data has been kept.',
    signIn: 'Sign in',
    reload: 'Reload',
    view: 'view-queue',
    cards: 0,
    queueActive: true,
    disabled: true,
    ariaDisabled: 'true',
    profileActive: false,
  }), []);
  assert.deepEqual(profileLockFailures({
    disabled: true,
    ariaDisabled: 'true',
    view: 'view-map',
    profileActive: false,
    showsStoredProfile: false,
    showsPersonalTarget: false,
  }), []);
  assert.deepEqual(profileReadyFailures({
    disabled: false,
    ariaDisabled: null,
    view: 'view-profile',
    body: 'Anil',
  }), []);
});
