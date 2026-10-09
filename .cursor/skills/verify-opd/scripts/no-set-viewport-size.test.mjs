import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const needle = ['set', 'Viewport', 'Size'].join('');

function scriptFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      scriptFiles(path, found);
      continue;
    }
    if (name.endsWith('.mjs') || name.endsWith('.js')) found.push(path);
  }
  return found;
}

test('verify-opd scripts open a context per size and do not resize the page', () => {
  const hits = [];
  for (const path of scriptFiles(scriptsDir)) {
    const text = readFileSync(path, 'utf8');
    if (text.includes(needle)) hits.push(relative(scriptsDir, path));
  }
  assert.deepEqual(hits, []);
});
