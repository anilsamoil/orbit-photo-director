import { checksFor, decodePair } from '/src/map/adapters/maplibre/iss-g1-page.ts';
import { angularSeparationDeg, reconstructCamera, verticalAngleDeg } from '/src/iss-g1/model.ts';
import { EARTH_VIEW_ROLL_DEG, sceneFrame } from '/src/iss-view/model.ts';
import { subsolarPoint } from '/src/terminator.ts';
import { isTilePixel, waitFor } from './probes.mjs';

const projectionLayer = 'g1-runtime-projection';
const nestedLayer = 'g1-visible-nest';
const angleError = (actual, expected) => Math.abs(((actual - expected + 540) % 360) - 180);

function earthCoverage({ bytes, width, height }) {
  let earth = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    if (isTilePixel(bytes, index, 'iss')) earth++;
  }
  const column = Math.floor(width / 2);
  let row = null;
  // gl.readPixels starts at the bottom. The ISS preset's 180° roll puts
  // Earth above the limb, so the raw column is already in measurement order.
  for (let y = 0; y < height; y++) {
    if (isTilePixel(bytes, (y * width + column) * 4, 'iss')) {
      row = y;
      break;
    }
  }
  return { row, fraction: earth / (width * height) };
}

export async function measureGeometry({ map, track, when, preset, pixels, tileFrame, holdCamera }) {
  let runtime;
  map.addLayer({
    id: projectionLayer, type: 'custom',
    render(_gl, { shaderData, defaultProjectionData }) {
      runtime = {
        projection: map.painter.style.projection.name,
        shaderVariant: shaderData.variantName,
        transition: defaultProjectionData.projectionTransition,
      };
    },
  });
  const measure = async (readFrame) => {
    runtime = null;
    const frame = await readFrame();
    const active = runtime?.projection === 'vertical-perspective'
      && runtime.shaderVariant === 'globe' && runtime.transition === 1;
    return { ...frame, runtime, projection: active ? 'vertical-perspective' : 'unexpected' };
  };
  const measurePreset = async (name) => {
    const modeled = sceneFrame(track, when, name);
    if (!modeled.ok) throw new Error('Fixture cannot calculate ISS ' + name + ': ' + modeled.reason);
    const pose = modeled.pose;
    await preset(map, name);
    const frame = await measure(() => pixels(map, true));
    const applied = frame.camera;
    const camera = reconstructCamera({
      targetLatDeg: applied.lat, targetLonDeg: applied.lng, pitchDeg: applied.pitch,
      bearingDeg: applied.bearing, zoom: applied.zoom, verticalFovDeg: applied.verticalFovDeg,
      viewportHeightPx: map.getCanvas().clientHeight,
    });
    const expected = map.calculateCameraOptionsFromTo(
      [pose.camera.lonDeg, pose.camera.latDeg], pose.altitudeM, [pose.targetLonDeg, pose.targetLatDeg], 0,
    );
    const earth = earthCoverage(frame);
    const appliedPose = Math.abs(applied.lat - pose.targetLatDeg) < 0.01
      && angleError(applied.lng, pose.targetLonDeg) < 0.01
      && angleError(applied.bearing, pose.bearingDeg) < 0.01
      && angleError(applied.roll, EARTH_VIEW_ROLL_DEG) < 0.01
      && Math.abs(applied.zoom - expected.zoom) < 0.001;
    return {
      preset: name, applied, expectedZoom: expected.zoom, appliedPose, runtime: frame.runtime,
      projection: frame.projection, verticalFovDeg: applied.verticalFovDeg, maxPitchDeg: map.getMaxPitch(),
      pitchDeg: applied.pitch, analyticPitchDeg: pose.analyticPitchDeg, bearingDeg: applied.bearing,
      inwardDeg: pose.inwardDeg, camera, intended: pose.camera, radiusErrorM: camera.radiusM - pose.camera.radiusM,
      subpointErrorDeg: angularSeparationDeg(camera.latDeg, camera.lonDeg, pose.camera.latDeg, pose.camera.lonDeg),
      limbErrorDeg: name === 'horizon' && earth.row !== null
        ? verticalAngleDeg(earth.row, frame.height, applied.verticalFovDeg) - pose.inwardDeg : null,
      earthFraction: earth.fraction, nested: 'missing',
    };
  };
  try {
    const horizon = await measurePreset('horizon');
    const nadir = await measurePreset('nadir');
    const center = [nadir.applied.lng, nadir.applied.lat];
    map.addSource(nestedLayer, {
      type: 'geojson',
      data: { type: 'Feature', properties: { nest: { ok: true, n: 2 } }, geometry: { type: 'Point', coordinates: center } },
    });
    map.addLayer({ id: nestedLayer, source: nestedLayer, type: 'circle' });
    await waitFor(() => map.isSourceLoaded(nestedLayer), 'visible ISS nested fixture');
    await pixels(map);
    const nest = map.queryRenderedFeatures(map.project(center), { layers: [nestedLayer] })[0]?.properties?.nest;
    nadir.nested = nest && typeof nest === 'object' ? 'object' : typeof nest === 'string' ? 'string' : 'missing';
    map.removeLayer(nestedLayer);
    map.removeSource(nestedLayer);

    let zoom12;
    holdCamera(true);
    try {
      map.jumpTo({ zoom: 12 });
      const frame = await measure(tileFrame);
      zoom12 = { projection: frame.projection, runtime: frame.runtime, applied: frame.camera, tilePixels: frame.tilePixels };
    } finally {
      holdCamera(false);
      if (map.getLayer(projectionLayer)) map.jumpTo({ zoom: nadir.applied.zoom });
    }
    const { blue, black, nasaTiles } = await decodePair(subsolarPoint(new Date(when)));
    const checks = checksFor(horizon, nadir, zoom12.projection, blue, black);
    checks.push(
      { name: 'horizon and nadir poses applied', pass: horizon.appliedPose && nadir.appliedPose },
      { name: 'zoom 12 applied', pass: Math.abs(zoom12.applied.zoom - 12) < 0.001 },
    );
    const evidence = { horizon, nadir, zoom12, nasaTiles, checks };
    if (!checks.every(({ pass }) => pass)) {
      throw Object.assign(new Error('Visible ISS geometry assertion failed'), { evidence });
    }
    return evidence;
  } finally {
    if (map.getLayer(nestedLayer)) map.removeLayer(nestedLayer);
    if (map.getSource(nestedLayer)) map.removeSource(nestedLayer);
    if (map.getLayer(projectionLayer)) map.removeLayer(projectionLayer);
  }
}
