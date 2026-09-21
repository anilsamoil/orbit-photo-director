import type maplibregl from 'maplibre-gl';

import type { LngLat, Point } from '../../map-core/geometry';
import type { Hit, LayerEvents, LayerTap, Tap, VendorEvents } from '../../map-core/vendor-map';

type Handler<T> = (payload: T) => void;

export function toLngLat(at: { lng: number; lat: number }): LngLat {
  return [at.lng, at.lat];
}

export function toHit(feature: maplibregl.MapGeoJSONFeature): Hit {
  return { properties: feature.properties, geometry: feature.geometry };
}

function toTap(event: maplibregl.MapMouseEvent): Tap {
  return { point: { x: event.point.x, y: event.point.y }, lngLat: toLngLat(event.lngLat) };
}

function toTouches(event: maplibregl.MapTouchEvent): Point[] {
  return Array.from(event.originalEvent?.touches ?? [], (touch) => ({ x: touch.clientX, y: touch.clientY }));
}

/** MapLibre types its error and data events without the source fields the
 *  app reads, so they are read the way the app always has: off the object. */
function sourceIdOf(event: unknown): string | undefined {
  return (event as { sourceId?: string } | undefined)?.sourceId;
}

function tileLoaded(event: unknown): boolean {
  return (event as { tile?: { state?: string } } | undefined)?.tile?.state === 'loaded';
}

/** Wrap a domain handler as the MapLibre listener for `event`. The return
 *  value is what to pass to `map.on` and, later, `map.off`. */
export function mapListener<K extends keyof VendorEvents>(
  event: K,
  handler: Handler<VendorEvents[K]>,
): maplibregl.Listener {
  const deliver = handler as Handler<unknown>;
  switch (event) {
    case 'click':
      return (e: maplibregl.MapMouseEvent) => deliver(toTap(e));
    case 'contextmenu':
      return (e: maplibregl.MapMouseEvent) => {
        e.preventDefault();
        deliver(toTap(e));
      };
    case 'touchstart':
      return (e: maplibregl.MapTouchEvent) => deliver({ lngLat: toLngLat(e.lngLat), touches: toTouches(e) });
    case 'touchmove':
      return (e: maplibregl.MapTouchEvent) => deliver({ touches: toTouches(e) });
    case 'zoomstart':
      return (e: { originalEvent?: unknown } | undefined) => deliver({ byUser: Boolean(e?.originalEvent) });
    case 'error':
      return (e: unknown) => deliver({ sourceId: sourceIdOf(e) });
    case 'data':
      return (e: unknown) => deliver({ sourceId: sourceIdOf(e), tileLoaded: tileLoaded(e) });
    default:
      return () => deliver(undefined);
  }
}

export function layerListener<K extends keyof LayerEvents>(
  event: K,
  handler: Handler<LayerEvents[K]>,
): maplibregl.Listener {
  const deliver = handler as Handler<unknown>;
  if (event === 'click') {
    return (e: maplibregl.MapLayerMouseEvent) => {
      const tap: LayerTap = { ...toTap(e), features: (e.features ?? []).map(toHit) };
      deliver(tap);
    };
  }
  return () => deliver(undefined);
}
