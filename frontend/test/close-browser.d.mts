import type { Browser, BrowserType } from 'playwright';

export type TrackedBrowser = {
  browser: Browser;
  server: {
    close(): Promise<void>;
    kill(): Promise<void>;
    process(): { pid?: number };
    wsEndpoint(): string;
  };
};

export function launchTracked(
  browserType: BrowserType,
  options?: Parameters<BrowserType['launchServer']>[0],
): Promise<TrackedBrowser>;

export function closeBrowser(
  session: {
    browser?: { close(): Promise<unknown>; contexts?: () => ReadonlyArray<{ close(): Promise<unknown> }> };
    server?: { close(): Promise<unknown>; kill?: () => Promise<unknown> };
    close?: () => Promise<unknown>;
    kill?: () => Promise<unknown>;
  } | undefined,
  label?: string,
): Promise<void>;
