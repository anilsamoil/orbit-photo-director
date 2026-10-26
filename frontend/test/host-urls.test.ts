import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('published map urls', () => {
  it('does not point canonical or og:url at one host', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8');
    expect(html).not.toMatch(/rel=["']canonical["']/);
    expect(html).not.toMatch(/property=["']og:url["']/);
  });

  it('registers the service worker for the page origin', () => {
    const source = readFileSync(resolve(root, 'public/registerSW.js'), 'utf8');
    expect(source).toContain("register('/sw.js', { scope: '/'");
    expect(source).not.toContain('map.astroanil.dev');
    expect(source).not.toContain('map.expedition75.com');
  });
});
