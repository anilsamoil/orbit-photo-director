import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

describe('side column scroll', () => {
  it('scrolls the side column and keeps telemetry at its content height', () => {
    const column = rule("[data-iss-side-dock='on'] [data-iss-side]");
    const telemetry = rule("[data-iss-side-dock='on'] [data-iss-side] [data-iss-telemetry-body]");
    expect(column).toContain('overflow-y: auto');
    expect(column).not.toContain('overflow: hidden');
    expect(telemetry).toContain('flex: 0 0 auto');
    expect(telemetry).toContain('overflow: visible');
    expect(telemetry).not.toContain('flex: 1 1 auto');
  });
});
