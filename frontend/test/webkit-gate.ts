import { existsSync } from 'node:fs';
import { webkit, type Browser } from 'playwright';

/** Result of one look at WebKit. `reason` exists only when it did not start. */
export type WebKitAvailability =
  | { readonly status: 'launchable' }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * Boundary inputs for one decision.
 * Only the string `true` is CI. `probe` launches. `stat` only checks the path.
 */
export type WebKitGateIo = {
  readonly env: { readonly CI?: string };
  readonly probe: () => Promise<WebKitAvailability>;
  readonly stat: () => WebKitAvailability;
  readonly warn: (line: string) => void;
};

/**
 * When `CI` is `true`, launches WebKit and throws if it cannot.
 * Otherwise warns once when the binary is missing and returns.
 * A skipped WebKit suite cannot run until this returns.
 */
export async function enforceWebKitGate(io: WebKitGateIo = defaultWebKitGateIo()): Promise<void> {
  if (io.env.CI === 'true') {
    const availability = await io.probe();
    if (availability.status === 'unavailable') throw new Error(unavailableLine(availability.reason));
    return;
  }
  const availability = io.stat();
  if (availability.status === 'unavailable') io.warn(unavailableLine(availability.reason));
}

/** Vitest calls this before workers load tests. A throw exits the run. */
export default async function setup(_context: unknown): Promise<void> {
  await enforceWebKitGate();
}

function unavailableLine(reason: string): string {
  return `WebKit unavailable: ${reason}. From frontend/, run ./node_modules/.bin/playwright install --with-deps webkit.`;
}

function warnOnStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function defaultWebKitGateIo(): WebKitGateIo {
  return { env: { CI: process.env.CI }, probe: probeWebKit, stat: statWebKit, warn: warnOnStderr };
}

function statWebKit(): WebKitAvailability {
  const path = webkit.executablePath();
  if (!existsSync(path)) return { status: 'unavailable', reason: `no browser at ${path}` };
  return { status: 'launchable' };
}

async function probeWebKit(): Promise<WebKitAvailability> {
  const path = webkit.executablePath();
  if (!existsSync(path)) return { status: 'unavailable', reason: `no browser at ${path}` };
  let browser: Browser | undefined;
  try {
    browser = await webkit.launch({ headless: true, executablePath: path, timeout: 30_000 });
    return { status: 'launchable' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'unavailable', reason: `launch failed at ${path}: ${message}` };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
