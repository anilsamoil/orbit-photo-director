import { describe, expect, it } from 'vitest';

import { createVendorDouble } from './vendor-map-double';
import { labels } from '../src/map/features/labels';
import { nightLights } from '../src/map/features/night-lights';
import { bindTerminatorClock, terminator } from '../src/map/features/terminator';
import { LAYER_ORDER } from '../src/map/map-core/catalog';
import { createClock } from '../src/map/map-core/clock';
import { createMapCore } from '../src/map/map-core/core';

describe('wave-two mount order', () => {
  it('paints catalog order when terminator, night lights and labels mount in reverse', () => {
    const vendor = createVendorDouble({
      sources: [
        ['viirs-night-lights', { type: 'raster', tiles: ['https://v/{z}/{x}/{y}.png'], tileSize: 256 }],
        ['esri-labels-reference', { type: 'raster', tiles: ['https://l/{z}/{x}/{y}.png'], tileSize: 256 }],
      ],
    });
    const clock = createClock();
    bindTerminatorClock(clock);
    const core = createMapCore(vendor, clock);
    terminator.mount(core);
    nightLights.mount(core);
    labels.mount(core);
    const painted = vendor.paintedLayers();
    expect(painted).toEqual(LAYER_ORDER.filter((id) => painted.includes(id)));
  });
});
