import { describe, expect, it } from 'vitest';
import { paintEqualDigits } from '../src/digits';

describe('equal-width digit cells', () => {
  it('puts each digit and colon in its own cell and keeps the readable text', () => {
    document.head.innerHTML = '<style>.digit{display:inline-block;width:0.56em}.digit-sep{display:inline-block;width:0.28em}</style>';
    document.body.innerHTML = '<span id="clock"></span>';
    const el = document.getElementById('clock')!;
    paintEqualDigits(el, '14:05:09Z');
    expect(el.textContent).toBe('14:05:09Z');
    expect([...el.querySelectorAll('.digit')].map((node) => node.textContent).join('')).toBe('140509');
    expect(el.querySelectorAll('.digit-sep')).toHaveLength(2);
    const widths = [...el.querySelectorAll('.digit')].map((node) => getComputedStyle(node).width);
    expect(new Set(widths).size).toBe(1);
    paintEqualDigits(el, '14:05:09Z');
    expect(el.querySelectorAll('.digit')).toHaveLength(6);
  });
});
