import type { MapFeature } from '../map-core/feature';
import { pinDrop } from './pin-drop';
import { satellites } from './satellites';

export const FEATURES: readonly MapFeature[] = [pinDrop, satellites];
