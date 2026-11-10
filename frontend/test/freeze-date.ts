import type { Page } from 'playwright';

import { installFrozenDate } from './frozen-date.mjs';

/** `page.clock.setFixedTime` replaces `performance.now()`, animation frames, and `Event.timeStamp`.
 *  Its timer runner puts that performance clock on a late timer's deadline while the timer yields. */
export async function freezeDate(page: Page, time: Date | number | string): Promise<void> {
  const millis = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : Date.parse(time);
  await page.addInitScript(installFrozenDate, millis);
}

export { installFrozenDate };
