export type PlanPlace = {
  name: string;
  lon: number;
  lat: number;
  minZoom: number;
};

/** Vector country names stop here. The reference raster draws place names from this zoom, and those tiles cannot join symbol collision. */
export const PLAN_RASTER_NAME_ZOOM = 3;

const COUNTRIES: readonly PlanPlace[] = [
  { name: 'Canada', lon: -100, lat: 50, minZoom: 0 },
  { name: 'Mexico', lon: -102, lat: 23, minZoom: 0 },
  { name: 'Brazil', lon: -55, lat: -10, minZoom: 0 },
  { name: 'Argentina', lon: -64, lat: -34, minZoom: 0 },
  { name: 'France', lon: 2, lat: 46, minZoom: 0 },
  { name: 'Egypt', lon: 30, lat: 26, minZoom: 0 },
  { name: 'Nigeria', lon: 8, lat: 10, minZoom: 0 },
  { name: 'Kenya', lon: 38, lat: 1, minZoom: 0 },
  { name: 'China', lon: 104, lat: 35, minZoom: 0 },
  { name: 'India', lon: 79, lat: 22, minZoom: 0 },
  { name: 'Japan', lon: 138, lat: 36, minZoom: 0 },
  { name: 'Australia', lon: 134, lat: -25, minZoom: 0 },
];

/** One label system for this zoom. Raster place names own the zoom once they appear. */
export function planNameSystem(zoom: number): 'vector' | 'raster' {
  return zoom < PLAN_RASTER_NAME_ZOOM ? 'vector' : 'raster';
}

/** Names for one plan-map zoom. The raster range has no vector names. */
export function planPlaces(zoom: number): readonly PlanPlace[] {
  if (planNameSystem(zoom) !== 'vector') return [];
  return COUNTRIES;
}

export function planTier(minZoom: number): readonly PlanPlace[] {
  return COUNTRIES.filter((place) => place.minZoom === minZoom);
}
