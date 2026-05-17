/**
 * Tests for score-stars.ts (V4-P2 5-star conversion).
 *
 * Coverage:
 * - scoreToStars: every threshold boundary (exact + just-below)
 * - scoreToStars: defensive guards (NaN, undefined, null, negative, > 100)
 * - renderStarBlock: glyph composition, aria-label, role
 * - renderStarBlock: clamping invalid star counts to [1, maxStars]
 * - starsToLabel: word anchor for each tier
 */
import { describe, expect, it } from 'vitest';

import {
  STAR_THRESHOLDS,
  renderStarBlock,
  scoreToStars,
  starsToLabel,
} from '../src/score-stars';

describe('scoreToStars', () => {
  it('returns 5 for scores at or above 75', () => {
    expect(scoreToStars(75)).toBe(5);
    expect(scoreToStars(75.0)).toBe(5);
    expect(scoreToStars(85)).toBe(5);
    expect(scoreToStars(100)).toBe(5);
  });

  it('returns 4 for scores in [50, 75)', () => {
    expect(scoreToStars(50)).toBe(4);
    expect(scoreToStars(60)).toBe(4);
    expect(scoreToStars(74.99)).toBe(4);
  });

  it('returns 3 for scores in [30, 50)', () => {
    expect(scoreToStars(30)).toBe(3);
    expect(scoreToStars(40)).toBe(3);
    expect(scoreToStars(49.99)).toBe(3);
  });

  it('returns 2 for scores in [15, 30)', () => {
    expect(scoreToStars(15)).toBe(2);
    expect(scoreToStars(20)).toBe(2);
    expect(scoreToStars(29.99)).toBe(2);
  });

  it('returns 1 for scores below 15', () => {
    expect(scoreToStars(0)).toBe(1);
    expect(scoreToStars(10)).toBe(1);
    expect(scoreToStars(14.99)).toBe(1);
  });

  it('returns 1 for NaN, null, undefined, negative (defensive)', () => {
    expect(scoreToStars(NaN)).toBe(1);
    expect(scoreToStars(null)).toBe(1);
    expect(scoreToStars(undefined)).toBe(1);
    expect(scoreToStars(-1)).toBe(1);
    expect(scoreToStars(-100)).toBe(1);
  });

  it('clamps scores >100 to 5★ (defensive against future schema drift)', () => {
    expect(scoreToStars(101)).toBe(5);
    expect(scoreToStars(1000)).toBe(5);
  });

  it('exports the threshold constants for callers', () => {
    expect(STAR_THRESHOLDS.five).toBe(75);
    expect(STAR_THRESHOLDS.four).toBe(50);
    expect(STAR_THRESHOLDS.three).toBe(30);
    expect(STAR_THRESHOLDS.two).toBe(15);
  });
});

describe('renderStarBlock', () => {
  it('renders filled + hollow stars for a 3/5 input', () => {
    const span = renderStarBlock(3);
    expect(span.textContent).toBe('★★★☆☆');
    expect(span.className).toBe('score-stars');
  });

  it('renders all filled for 5/5', () => {
    expect(renderStarBlock(5).textContent).toBe('★★★★★');
  });

  it('renders one filled for 1/5', () => {
    expect(renderStarBlock(1).textContent).toBe('★☆☆☆☆');
  });

  it('sets aria-label so screen readers say "N of 5 stars"', () => {
    expect(renderStarBlock(3).getAttribute('aria-label')).toBe('3 of 5 stars');
    expect(renderStarBlock(5).getAttribute('aria-label')).toBe('5 of 5 stars');
  });

  it('sets role="img" so the unicode glyphs are announced as an image not raw text', () => {
    expect(renderStarBlock(3).getAttribute('role')).toBe('img');
  });

  it('clamps invalid star counts to [1, maxStars]', () => {
    expect(renderStarBlock(0).textContent).toBe('★☆☆☆☆');     // clamped up to 1
    expect(renderStarBlock(-3).textContent).toBe('★☆☆☆☆');    // negative → 1
    expect(renderStarBlock(7).textContent).toBe('★★★★★');     // clamped down to 5
    expect(renderStarBlock(3.4).textContent).toBe('★★★☆☆');   // rounds to 3
    expect(renderStarBlock(3.6).textContent).toBe('★★★★☆');   // rounds to 4
  });

  it('supports custom maxStars (defensive; default 5 covers all callers today)', () => {
    expect(renderStarBlock(3, 10).textContent).toBe('★★★☆☆☆☆☆☆☆');
    expect(renderStarBlock(3, 10).getAttribute('aria-label')).toBe('3 of 10 stars');
  });
});

describe('starsToLabel', () => {
  it('returns operator-friendly word anchors per tier', () => {
    expect(starsToLabel(5)).toBe('excellent');
    expect(starsToLabel(4)).toBe('solid');
    expect(starsToLabel(3)).toBe('worth knowing');
    expect(starsToLabel(2)).toBe('marginal');
    expect(starsToLabel(1)).toBe('poor');
  });

  it('defaults to "poor" for invalid input (defensive)', () => {
    expect(starsToLabel(0)).toBe('poor');
    expect(starsToLabel(-1)).toBe('poor');
    expect(starsToLabel(NaN)).toBe('poor');
  });
});
