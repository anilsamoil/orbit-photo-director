import { describe, expect, it } from 'vitest';
import { CHROME_CANDIDATES, resolveChromiumExecutable } from './chromium-executable';

describe('chromium executable', () => {
  it('prefers an installed system Chrome', () => {
    const chosen = CHROME_CANDIDATES[1];
    expect(resolveChromiumExecutable((path) => path === chosen, '/playwright/chromium')).toBe(chosen);
  });

  it('uses Playwright Chromium when system Chrome is absent', () => {
    const playwrightPath = '/playwright/chromium';
    expect(resolveChromiumExecutable((path) => path === playwrightPath, playwrightPath)).toBe(playwrightPath);
  });

  it('fails when neither system Chrome nor Playwright Chromium exists', () => {
    expect(() => resolveChromiumExecutable(() => false, '/playwright/chromium')).toThrow(/Chromium is required at \/playwright\/chromium/);
  });
});
