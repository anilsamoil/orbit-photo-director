import { existsSync } from 'node:fs';
import { webkit, type Browser } from 'playwright';

export type WebKitAvailability =
  | { readonly status: 'launchable' }
  | { readonly status: 'unavailable'; readonly reason: string };

export type WebKitGateIo = {
  readonly ci: boolean;
  readonly probe: () => Promise<WebKitAvailability>;
  readonly stat: () => WebKitAvailability;
  readonly warn: (line: string) => void;
};

export function webKitRequired(env: { readonly CI?: string }): boolean {
  return env.CI === 'true';
}

export async function enforceWebKitGate(io: WebKitGateIo = defaultWebKitGateIo()): Promise<void> {
  if (io.ci) {
    const availability = await io.probe();
    if (availability.status === 'unavailable') throw new Error(unavailableLine(availability.reason));
    return;
  }
  const availability = io.stat();
  if (availability.status === 'unavailable') io.warn(unavailableLine(availability.reason));
}

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
  return { ci: webKitRequired(process.env), probe: probeWebKit, stat: statWebKit, warn: warnOnStderr };
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
