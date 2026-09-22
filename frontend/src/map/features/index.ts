import type { MapFeature } from '../map-core/feature';
import { basemap } from './basemap';
import { groundTrack } from './ground-track';
import { labels } from './labels';
import { nightLights } from './night-lights';
import { pinDrop } from './pin-drop';
import { satellites } from './satellites';
import { terminator } from './terminator';
import { followIss } from './follow-iss';
import { issMarker } from './iss-marker';
import { launchCorridor } from './launch-corridor';
import { targets } from './targets';
import { timeScrub } from './time-scrub';

export const FEATURES: readonly MapFeature[] = [
  basemap,
  pinDrop,
  satellites,
  labels,
  nightLights,
  terminator,
  groundTrack,
  issMarker,
  targets,
  launchCorridor,
  timeScrub,
  followIss,
];
