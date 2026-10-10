// These functions are self-contained so Playwright and the CDP drive can run
// the same clock in the page, without changing animation or interval timers.
export function freezeFixtureClock(frozen) {
  if (!Number.isFinite(frozen)) throw new Error('fixture clock needs a finite instant');
  const NativeDate = globalThis.__opdNativeDate || globalThis.Date;
  const realNow = globalThis.__opdRealNow || NativeDate.now;
  globalThis.__opdNativeDate = NativeDate;
  globalThis.__opdRealNow = realNow;
  function FixtureDate(...args) {
    // Read the current now method so the legacy Date.now = __opdRealNow
    // restoration also makes zero-argument construction and Date() live.
    if (!new.target) return new NativeDate(FixtureDate.now()).toString();
    return Reflect.construct(NativeDate, args.length ? args : [FixtureDate.now()], new.target);
  }
  Object.setPrototypeOf(FixtureDate, NativeDate);
  FixtureDate.prototype = NativeDate.prototype;
  Object.defineProperties(FixtureDate, {
    name: { value: 'Date', configurable: true },
    length: { value: 7, configurable: true },
    now: { value: () => frozen, configurable: true, writable: true },
    parse: { value: NativeDate.parse, configurable: true, writable: true },
    UTC: { value: NativeDate.UTC, configurable: true, writable: true },
  });
  globalThis.Date = FixtureDate;
  return true;
}

export function restoreFixtureClock() {
  if (globalThis.__opdNativeDate) globalThis.Date = globalThis.__opdNativeDate;
  if (globalThis.__opdRealNow) globalThis.Date.now = globalThis.__opdRealNow;
  return true;
}

// Playwright init scripts survive reloads and cannot be removed through its
// public API. Seed only this initial app response, before any module executes.
export async function installOneShotClock(page, url, frozen) {
  if (!Number.isFinite(frozen)) return async () => {};
  const target = new URL(url);
  target.hash = '';
  const source = `(${freezeFixtureClock.toString()})(${JSON.stringify(frozen)});`;
  const seed = async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const script = `<script>${source}</script>`;
    const body = /<head(?:\s[^>]*)?>/i.test(html)
      ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + script)
      : html.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + script);
    await route.fulfill({ response, body });
  };
  await page.route(target.href, seed, { times: 1 });
  return () => page.unroute(target.href, seed);
}
