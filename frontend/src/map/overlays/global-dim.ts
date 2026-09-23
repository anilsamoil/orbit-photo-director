import type { MapCore } from '../map-core/core';

const flags = {
  nightLights: false,
  terminator: true,
};

/** Night lights are on. The dim only paints when the terminator is off. */
export function setDimNightLights(on: boolean): void {
  flags.nightLights = on;
}

/** The terminator is on. The dim hides while it is, so the night fill
 *  is the only darkening. */
export function setDimTerminator(on: boolean): void {
  flags.terminator = on;
}

/** The whole-map dim. Lights on and terminator off. */
export function applyGlobalDim(core: MapCore): void {
  const dimVisible = flags.nightLights && !flags.terminator;
  try {
    core.setVisibility('night-lights-global-dim-layer', dimVisible ? 'visible' : 'none');
  } catch {}
}
