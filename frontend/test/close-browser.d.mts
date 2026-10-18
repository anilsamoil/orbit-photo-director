import type { Browser, BrowserType } from 'playwright';

export type TrackedProcess = {
  pid: number;
  pgid: number;
  startTicks: number;
};

export type TrackedBrowser = {
  browser: Browser;
  server: { close(): Promise<void> };
  tracked: TrackedProcess;
};

export function trackProcess(pid: number): TrackedProcess;

export function launchTracked(
  browserType: BrowserType,
  options?: Parameters<BrowserType['launchServer']>[0],
): Promise<TrackedBrowser>;

export function closeBrowser(
  session: {
    browser?: { close(): Promise<unknown>; contexts?: () => ReadonlyArray<{ close(): Promise<unknown> }> };
    server?: { close(): Promise<unknown> };
    close?: () => Promise<unknown>;
    tracked: TrackedProcess;
  } | undefined,
  label?: string,
): Promise<void>;
