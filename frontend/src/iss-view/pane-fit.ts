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
};

export type PaneFit = {
  widthPx: number;
  heightPx: number;
  verticalFovDeg: number;
  bodyMaxPx: number | null;
};

/** Stage height is reserved for the side labels before the telemetry body scrolls. */
export function fitIssPane(measure: PaneMeasure): PaneFit {
  const contentW = Math.max(1, measure.paneWidthPx - measure.padXPx - measure.sideWidthPx);
  const room = measure.paneHeightPx - measure.padYPx - measure.toolbarPx - measure.buttonPx - measure.gapPx * 2;
  const reserve = Math.max(measure.labelPx, 1);
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
  };
}
