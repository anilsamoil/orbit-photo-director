import type { MapFeature } from '../map-core/feature';
import { basemap } from './basemap';
import { pinDrop } from './pin-drop';
import { satellites } from './satellites';

export const FEATURES: readonly MapFeature[] = [basemap, pinDrop, satellites];
