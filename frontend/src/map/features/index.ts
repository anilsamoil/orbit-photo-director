import type { MapFeature } from '../map-core/feature';
import { basemap } from './basemap';
import { labels } from './labels';
import { nightLights } from './night-lights';
import { pinDrop } from './pin-drop';
import { satellites } from './satellites';
import { terminator } from './terminator';

export const FEATURES: readonly MapFeature[] = [basemap, pinDrop, satellites, labels, nightLights, terminator];
