import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

export const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/opt/homebrew/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function resolveChromiumExecutable(exists: (path: string) => boolean, playwrightPath: string): string {
  const installed = CHROME_CANDIDATES.find((path) => exists(path));
  const path = installed ?? playwrightPath;
  if (!exists(path)) throw new Error(`Chromium is required at ${path}`);
  return path;
}

export function chromiumExecutablePath(): string {
  return resolveChromiumExecutable(existsSync, chromium.executablePath());
}
