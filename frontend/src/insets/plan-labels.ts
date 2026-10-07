import { PLACE_CITIES } from '../iss-view/place-labels';

export type PlanPlace = {
  name: string;
  lon: number;
  lat: number;
  minZoom: number;
};

/** Country names. The Esri reference raster has none until the fit zooms in. */
export const PLAN_CITY_ZOOM = 3;

/** Towns. The city tier is already on screen. */
export const PLAN_TOWN_ZOOM = 5;

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

const TOWNS: readonly PlanPlace[] = [
  { name: 'Salem', lon: -70.9, lat: 42.52, minZoom: PLAN_TOWN_ZOOM },
  { name: 'Houston', lon: -95.37, lat: 29.76, minZoom: PLAN_TOWN_ZOOM },
  { name: 'Dubai', lon: 55.27, lat: 25.2, minZoom: PLAN_TOWN_ZOOM },
  { name: 'Lisbon', lon: -9.14, lat: 38.72, minZoom: PLAN_TOWN_ZOOM },
  { name: 'Oslo', lon: 10.75, lat: 59.91, minZoom: PLAN_TOWN_ZOOM },
  { name: 'Honolulu', lon: -157.86, lat: 21.31, minZoom: PLAN_TOWN_ZOOM },
];

const PLACES: readonly PlanPlace[] = [
  ...COUNTRIES,
  ...PLACE_CITIES.map((city) => ({
    name: city.name,
    lon: city.lon,
    lat: city.lat,
    minZoom: PLAN_CITY_ZOOM,
  })),
  ...TOWNS,
];

/** Names for one plan-map zoom. Higher zooms keep every lower tier. */
export function planPlaces(zoom: number): readonly PlanPlace[] {
  return PLACES.filter((place) => place.minZoom <= zoom);
}

export function planTier(minZoom: number): readonly PlanPlace[] {
  return PLACES.filter((place) => place.minZoom === minZoom);
}
