import type { LayerId, SourceId } from './catalog';

export type Visibility = 'visible' | 'none';

/** A style expression: the operator name, then its operands. */
export type Expression = readonly [op: string, ...operands: unknown[]];

type Value<T> = T | Expression;

type Layout = { visibility?: Visibility };

export type RasterLayer = {
  id: LayerId;
  type: 'raster';
  source: SourceId;
  layout?: Layout;
  paint?: { 'raster-opacity'?: Value<number> };
};

export type LineLayer = {
  id: LayerId;
  type: 'line';
  source: SourceId;
  layout?: Layout;
  paint?: {
    'line-color'?: Value<string>;
    'line-width'?: Value<number>;
    'line-opacity'?: Value<number>;
    'line-blur'?: Value<number>;
    'line-dasharray'?: number[];
  };
};

export type FillLayer = {
  id: LayerId;
  type: 'fill';
  source: SourceId;
  layout?: Layout;
  paint?: {
    'fill-color'?: Value<string>;
    'fill-opacity'?: Value<number>;
    'fill-antialias'?: boolean;
  };
};

export type CircleLayer = {
  id: LayerId;
  type: 'circle';
  source: SourceId;
  layout?: Layout;
  paint?: {
    'circle-radius'?: Value<number>;
    'circle-color'?: Value<string>;
    'circle-opacity'?: Value<number>;
    'circle-stroke-color'?: Value<string>;
    'circle-stroke-width'?: Value<number>;
    'circle-stroke-opacity'?: Value<number>;
  };
};

export type BackgroundLayer = {
  id: LayerId;
  type: 'background';
  layout?: Layout;
  paint?: {
    'background-color'?: Value<string>;
    'background-opacity'?: Value<number>;
  };
};

export type LayerSpec = RasterLayer | LineLayer | FillLayer | CircleLayer | BackgroundLayer;

export type RasterSource = {
  type: 'raster';
  tiles: string[];
  tileSize: number;
  maxzoom?: number;
  attribution?: string;
};

export type GeoJsonSource = {
  type: 'geojson';
  data: GeoJSON.FeatureCollection;
};

export type SourceSpec = RasterSource | GeoJsonSource;

/** What the vendor is handed at construction. The adapter adds the style
 *  version and any vendor-only fields. */
export type StyleSpec = {
  sources: Partial<Record<SourceId, SourceSpec>>;
  layers: LayerSpec[];
};
