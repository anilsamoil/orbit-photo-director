import { describe, expect, it } from 'vitest';
import { moduleReferences } from '../src/map-import';

describe('map module regexp boundaries', () => {
  it.each([
    'function canary() {}',
    'export function canary() {}',
    'export default function canary() {}',
    'export default function() {}',
    'async function canary() {}',
    'export async function canary() {}',
    'function* canary() {}',
    'async function* canary() {}',
    'function canary({ value = (() => ({ quote: "x" }))() } = {}) { return value; }',
    'function outer() { function nested() {} /["\']/.test("x"); }',
  ])('recognizes regex literals after a function declaration: %s', (declaration) => {
    const source = `${declaration}\n/["']/.test(location.hash); /[a-z]+/.test(location.hash); import './real.js';`;
    expect(moduleReferences(source).map(({ specifier }) => specifier)).toEqual(['./real.js']);
  });

  it('recognizes an alphabetic regex immediately after a function declaration', () => {
    const source = 'function canary() {} /[a-z]+/.test(location.hash); import("./real.js");';
    expect(moduleReferences(source).map(({ specifier }) => specifier)).toEqual(['./real.js']);
  });

  it('does not collect ghost imports from a regex after a function declaration', () => {
    const source = `function canary() {} /import("ghost.js")/.test(location.hash); import('./real.js');`;
    expect(moduleReferences(source)).toEqual([
      { start: source.lastIndexOf("'./real.js'"), end: source.lastIndexOf("'./real.js'") + 11, specifier: './real.js', dynamic: true },
    ]);
  });

  it.each([
    'const quotient = function named() {} / 2;',
    'const quotient = function() {} / 2;',
    'const quotient = async function named() {} / 2;',
    'const quotient = function* named() {} / 2;',
    'const quotient = { value: function named() {} / 2 };',
    'const quotient = { function() {} } / 2;',
    'const quotient = {} / 2;',
    'const quotient = (() => {}) / 2;',
    'object.function() / 2;',
    'function outer() { return function named() {} / 2; }',
    '`value:${function named() {} / 2}`;',
    '`value:${async function named() {} / 2}`;',
    '`outer:${`inner:${function named() {} / 2}`}`;',
  ])('preserves division after an expression: %s', (expression) => {
    const source = `${expression} import('./real.js'); const base = import.meta.url;`;
    expect(moduleReferences(source).map(({ specifier, dynamic }) => ({ specifier, dynamic }))).toEqual([
      { specifier: './real.js', dynamic: true },
      { specifier: null, dynamic: false },
    ]);
  });
});
