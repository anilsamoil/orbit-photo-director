export const NARROW_SLIDER_MAX_PANE = 719;
export const NARROW_SLIDER_RIGHT_GAP = 24;
export const WIDE_STRIP_BLEED_MARGIN = 80;

export function rgbaChannels(color) {
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(String(color || ''));
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

export function chipBacking(color) {
  const parsed = rgbaChannels(color);
  if (!parsed) return false;
  return parsed.a >= 0.7 && parsed.r <= 20 && parsed.g <= 24 && parsed.b <= 30;
}

export function paintIsClear(color) {
  if (color === 'transparent') return true;
  const parsed = rgbaChannels(color);
  return !!parsed && parsed.a === 0;
}

export function usesNarrowSliderContract(laid) {
  return typeof laid?.paneWidth === 'number' && laid.paneWidth <= NARROW_SLIDER_MAX_PANE;
}

export function timeStripOffscreen(laid) {
  if (!laid) return true;
  if (typeof laid.rightGap === 'number' && laid.rightGap < -1) return true;
  if (typeof laid.stripLeft === 'number' && laid.stripLeft < -1) return true;
  if (typeof laid.stripLeft === 'number' && typeof laid.paneLeft === 'number' && laid.stripLeft < laid.paneLeft - 1) return true;
  if (typeof laid.stripTop === 'number' && laid.stripTop < -1) return true;
  if (typeof laid.stripBottom === 'number' && typeof laid.innerHeight === 'number' && laid.stripBottom > laid.innerHeight + 1) return true;
  if (typeof laid.stripRight === 'number' && typeof laid.innerWidth === 'number' && laid.stripRight > laid.innerWidth + 1) return true;
  if (typeof laid.stripRight === 'number' && typeof laid.paneRight === 'number' && laid.stripRight > laid.paneRight + 1) return true;
  return false;
}

function wideFullBleed(laid) {
  if (typeof laid.stripWidth === 'number' && typeof laid.paneWidth === 'number') {
    return laid.stripWidth > laid.paneWidth - WIDE_STRIP_BLEED_MARGIN;
  }
  return laid.fullBleed === true;
}

export function timeStripLaidFailures(laid) {
  if (!laid) return ['missing'];
  const failures = [];
  if (!(Math.abs(laid.gap) <= 1)) failures.push('gap');
  if (laid.bottom !== '0px') failures.push('bottom');
  if (laid.rowGap !== '0px' || laid.columnGap !== '0px') failures.push('pane-gap');
  if (laid.paddingTop !== '0px' || laid.paddingRight !== '0px' || laid.paddingBottom !== '0px' || laid.paddingLeft !== '0px') failures.push('padding');
  if (!laid.covers) failures.push('covers');
  if (!paintIsClear(laid.color)) failures.push('paint');
  if (!chipBacking(laid.controls)) failures.push('backing');
  if (laid.hide) failures.push('hide');
  if (laid.legend) failures.push('legend');
  if (laid.zoom) failures.push('zoom');
  if (laid.pip) failures.push('pip');
  if (laid.events !== 'none') failures.push('events');
  const geometry = !laid.fitting || (
    Math.abs(laid.stripHeight - 96) <= 2
    && Math.abs(laid.rightGap - 204) <= 2
    && laid.slider >= 44
  );
  if (!geometry) failures.push('geometry');
  const narrowOk = !laid.narrow || (
    laid.reserved
    && Math.abs(laid.reserved.height - laid.reserved.expect) <= 2
  );
  if (!narrowOk) failures.push('reserved');
  if (usesNarrowSliderContract(laid)) {
    if (!(typeof laid.rightGap === 'number') || laid.rightGap > NARROW_SLIDER_RIGHT_GAP) failures.push('narrow-right-gap');
    if (timeStripOffscreen(laid)) failures.push('offscreen');
  } else if (wideFullBleed(laid)) {
    failures.push('full-bleed');
  }
  return failures;
}
