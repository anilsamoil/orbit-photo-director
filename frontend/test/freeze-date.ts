import type { Page } from 'playwright';

/** `page.clock.setFixedTime` replaces `performance.now()`, animation frames, and `Event.timeStamp`.
 *  Its timer runner puts that performance clock on a late timer's deadline while the timer yields. */
export async function freezeDate(page: Page, time: Date | number | string): Promise<void> {
  const millis = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : Date.parse(time);
  await page.addInitScript((fixed: number) => {
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(value?: number | string, month?: number, date?: number, hours?: number, minutes?: number, seconds?: number, ms?: number) {
        if (arguments.length === 0) super(fixed);
        else if (arguments.length === 1) super(value!);
        else super(value as number, month!, date, hours, minutes, seconds, ms);
      }

      static override now(): number {
        return fixed;
      }
    }
    window.Date = FixedDate as unknown as DateConstructor;
  }, millis);
}
