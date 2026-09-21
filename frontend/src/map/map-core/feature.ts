import type { MapCore } from './core';

export interface MapFeature {
  readonly id: string;
  mount(core: MapCore): void;
}
