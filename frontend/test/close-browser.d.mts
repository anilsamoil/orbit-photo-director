import type { ChildProcess } from 'node:child_process';
import type { Browser, BrowserType } from 'playwright';

export type TrackedBrowser = {
  browser: Browser;
  server: {
    close(): Promise<void>;
    kill(): Promise<void>;
    process(): ChildProcess;
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
    server?: {
      close(): Promise<unknown>;
      kill?: () => Promise<unknown>;
      process?: () => {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        once(event: 'exit', listener: () => void): void;
      };
    };
    close?: () => Promise<unknown>;
    kill?: () => Promise<unknown>;
  } | undefined,
  label?: string,
): Promise<{ killed: boolean; elapsedMs: number } | undefined>;
