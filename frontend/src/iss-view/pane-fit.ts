import { LAUNCH_MARK_MIN_PX } from './launches';
import { sceneFit } from './model';

export type PaneMeasure = {
  paneWidthPx: number;
  paneHeightPx: number;
  padXPx: number;
  padYPx: number;
  gapPx: number;
  toolbarPx: number;
  buttonPx: number;
  bodyPx: number;
  bodyMarginPx: number;
  sideWidthPx: number;
  labelPx: number;
  launchCardWidthPx: number;
  launchCardHeightPx: number;
  launchCardGapPx: number;
};

export type LaunchCardPlace = 'side' | 'below' | 'over' | 'off';

export type PaneFit = {
  widthPx: number;
  heightPx: number;
  verticalFovDeg: number;
  bodyMaxPx: number | null;
  launchCardPlace: LaunchCardPlace;
};

export const SHORT_ISS_WINDOW_PX = 564;

const NARROW_ISS_PANE_PX = 720;

export function sideDockActive(
  sceneWidthPx: number,
  windowHeightPx: number,
  fullscreen: boolean,
  split: boolean,
): boolean {
  if (fullscreen || split) return false;
  if (!(windowHeightPx > 0) || windowHeightPx > SHORT_ISS_WINDOW_PX) return false;
  return sceneWidthPx > NARROW_ISS_PANE_PX;
}

/** A card under the earth that leaves a shorter frame than this collapses the globe. */
export const USABLE_BELOW_EARTH_PX = 120;

/**
 * While the card is over the earth, the below-reserved short side must reach
 * this before the card returns underneath. 120 through 131 keeps the current
 * place. Under 120 enters over. 132 or more returns to below.
 */
export const BELOW_EARTH_RETURN_PX = 132;

export function storedLaunchPlace(value: string | undefined): LaunchCardPlace {
  if (value === 'over' || value === 'below' || value === 'side' || value === 'off') return value;
  return 'off';
}

export function launchCardCandidate(paneWidthPx: number, cardShown: boolean): LaunchCardPlace {
  if (!cardShown) return 'off';
  return paneWidthPx <= NARROW_ISS_PANE_PX ? 'below' : 'side';
}

export function fitIssPane(measure: PaneMeasure, previous: LaunchCardPlace = 'off'): PaneFit {
  const launchCardPlace = placeLaunchCard(measure);
  const reserved = layoutCard(measure, launchCardPlace, true);
  if (launchCardPlace === 'off') return reserved;
  const shortSide = Math.min(reserved.widthPx, reserved.heightPx);
  if (launchCardPlace === 'side') {
    if (shortSide >= LAUNCH_MARK_MIN_PX) return reserved;
    return overlay(measure, launchCardPlace);
  }
  const collapsed = shortSide < USABLE_BELOW_EARTH_PX;
  const holding = previous === 'over' && shortSide < BELOW_EARTH_RETURN_PX;
  if (collapsed || holding) return overlay(measure, launchCardPlace);
  return reserved;
}

function overlay(measure: PaneMeasure, launchCardPlace: LaunchCardPlace): PaneFit {
  return { ...layoutCard(measure, launchCardPlace, false), launchCardPlace: 'over' };
}

function layoutCard(measure: PaneMeasure, launchCardPlace: LaunchCardPlace, reserveCard: boolean): PaneFit {
  const cardWidth = Math.max(0, measure.launchCardWidthPx);
  const cardHeight = Math.max(0, measure.launchCardHeightPx);
  const cardGap = Math.max(0, measure.launchCardGapPx);
  const sideReserve = reserveCard && launchCardPlace === 'side' ? cardWidth + cardGap : 0;
  const belowReserve = reserveCard && launchCardPlace === 'below' ? cardHeight + cardGap : 0;
  const contentW = Math.max(1, measure.paneWidthPx - measure.padXPx - measure.sideWidthPx - sideReserve);
  const room = measure.paneHeightPx - measure.padYPx - measure.toolbarPx - measure.buttonPx - measure.gapPx * 2 - belowReserve;
  const sideCardPx = launchCardPlace === 'side' ? cardHeight : 0;
  const reserve = Math.max(measure.labelPx, sideCardPx, 1);
  const naturalStage = room - measure.bodyPx;
  const stageBudget = naturalStage >= reserve ? naturalStage : reserve;
  const fitted = sceneFit(contentW, Math.max(1, stageBudget));
  const capped = measure.bodyPx > 0 && naturalStage < reserve;
  const bodyMaxPx = capped ? Math.floor(Math.max(0, room - stageBudget - measure.bodyMarginPx)) : null;
  return {
    widthPx: fitted.widthPx,
    heightPx: fitted.heightPx,
    verticalFovDeg: fitted.verticalFovDeg,
    bodyMaxPx,
    launchCardPlace,
  };
}

function placeLaunchCard(measure: PaneMeasure): LaunchCardPlace {
  const width = Math.max(0, measure.launchCardWidthPx);
  const height = Math.max(0, measure.launchCardHeightPx);
  if (width === 0 && height === 0) return 'off';
  return measure.paneWidthPx <= NARROW_ISS_PANE_PX ? 'below' : 'side';
}
