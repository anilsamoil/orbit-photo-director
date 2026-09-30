import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

/** MapLibre 6 loads its worker from `import.meta.url` inside the package.
 *  Vite does not rewrite that URL, so tile requests would miss the worker.
 *  This points every map at the bundled same-origin worker file. */
setWorkerUrl(workerUrl);

export const mapLibreWorkerUrl: string = workerUrl;
