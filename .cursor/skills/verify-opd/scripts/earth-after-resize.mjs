/** Poisoned inline size used to prove the resize listener still owns layout. */
export const POISONED_EARTH = { width: 109, height: 72 };

/** Minimum settled earth after a landscape layout. */
export const SETTLED_EARTH_FLOOR = { width: 80, height: 80 };

/**
 * Same-turn oracle: read immediately after dispatch.
 * Fails a correct rAF-wrapped onResize that still settles to a usable earth.
 */
export function sameTurnEarthVerdict(sample) {
  const box = sample.sameTurn;
  if (!box || box.width < SETTLED_EARTH_FLOOR.width || box.height < SETTLED_EARTH_FLOOR.height) {
    return {
      ok: false,
      step: 'earth',
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      oracle: 'same-turn',
    };
  }
  return { ok: true, oracle: 'same-turn', width: Math.round(box.width), height: Math.round(box.height) };
}

/**
 * Settled oracle: read after layout/rotation has had a chance to run (rAF or real rotate).
 * Missing listener leaves the poisoned 109×72 frame and fails.
 * rAF-wrapped onResize that reaches a usable earth passes.
 */
export function settledEarthVerdict(sample) {
  const box = sample.afterSettle;
  if (!box || box.width < SETTLED_EARTH_FLOOR.width || box.height < SETTLED_EARTH_FLOOR.height) {
    return {
      ok: false,
      step: 'earth',
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      oracle: 'settled',
    };
  }
  return { ok: true, oracle: 'settled', width: Math.round(box.width), height: Math.round(box.height) };
}

export function rafWrappedMutant() {
  return {
    sameTurn: { ...POISONED_EARTH },
    afterSettle: { width: 278, height: 185 },
  };
}

export function missingListenerMutant() {
  return {
    sameTurn: { ...POISONED_EARTH },
    afterSettle: { ...POISONED_EARTH },
  };
}

export function syncListenerHealthy() {
  return {
    sameTurn: { width: 278, height: 185 },
    afterSettle: { width: 278, height: 185 },
  };
}

/**
 * Page expression body: poison, dispatch, settle on two animation frames, then read.
 * Two rAFs cover an onResize wrapped in requestAnimationFrame without waiting long
 * enough for the 500ms paint timer to clear a missing listener.
 */
export function earthAfterResizeReaders() {
  return `
async function settleEarthAfterResize() {
  const staleFrame = document.querySelector('[data-iss-frame]');
  if (staleFrame instanceof HTMLElement) {
    staleFrame.style.width = '${POISONED_EARTH.width}px';
    staleFrame.style.height = '${POISONED_EARTH.height}px';
  }
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const laidFrame = document.querySelector('[data-iss-frame]');
  const laidBox = laidFrame instanceof HTMLElement ? laidFrame.getBoundingClientRect() : null;
  if (!laidBox || laidBox.width < ${SETTLED_EARTH_FLOOR.width} || laidBox.height < ${SETTLED_EARTH_FLOOR.height}) {
    return {
      step: 'earth',
      width: laidBox ? Math.round(laidBox.width) : 0,
      height: laidBox ? Math.round(laidBox.height) : 0,
    };
  }
  return { ok: true, width: Math.round(laidBox.width), height: Math.round(laidBox.height) };
}
`;
}
