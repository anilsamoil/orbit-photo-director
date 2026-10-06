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

const NARROW_ISS_PANE_PX = 720;

/** A card under the earth that leaves a shorter frame than this collapses the globe. */
const USABLE_BELOW_EARTH_PX = 120;

export function fitIssPane(measure: PaneMeasure): PaneFit {
  const launchCardPlace = placeLaunchCard(measure);
  const reserved = layoutCard(measure, launchCardPlace, true);
  const shortSide = Math.min(reserved.widthPx, reserved.heightPx);
  const floor = launchCardPlace === 'below' ? USABLE_BELOW_EARTH_PX : LAUNCH_MARK_MIN_PX;
  if (launchCardPlace === 'off' || shortSide >= floor) return reserved;
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
