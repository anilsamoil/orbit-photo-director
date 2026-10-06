// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchCatalog } from '../src/iss-view/catalog-load';
import { readCatalog } from '../src/iss-view/catalog-read';

const CAMBRIDGE = ['town', 'Cambridge', -71.11, 42.37, 17, 1];
const CAMBRIDGE_POINT = { kind: 'town', name: 'Cambridge', lon: -71.11, lat: 42.37, maxFovDeg: 17, rank: 1 };

describe('catalog load retries a failed response', () => {
  let server: Server;
  let url = '';
  let hits = 0;
  let statusForHit = (_hit: number): number => 200;
  let bodyForHit = (_hit: number): string | null => null;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      const status = statusForHit(hits);
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('unavailable');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(bodyForHit(hits) ?? JSON.stringify([CAMBRIDGE]));
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}/label-catalog-towns.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it('issues a new request after a 500 and returns the rows', async () => {
    hits = 0;
    bodyForHit = () => null;
    statusForHit = (hit) => (hit === 1 ? 500 : 200);
    await expect(fetchCatalog(url)).rejects.toThrow();
    const rows = await fetchCatalog(url).catch(() => null);
    expect(hits).toBe(2);
    expect(rows).toEqual([CAMBRIDGE]);
  });

  it('issues a new request after a 404 and returns the rows', async () => {
    hits = 0;
    bodyForHit = () => null;
    statusForHit = (hit) => (hit === 1 ? 404 : 200);
    await expect(fetchCatalog(url)).rejects.toThrow();
    const rows = await fetchCatalog(url).catch(() => null);
    expect(hits).toBe(2);
    expect(rows).toEqual([CAMBRIDGE]);
  });

  it('retries a non-array 200 and still throws when the body stays an object', async () => {
    hits = 0;
    statusForHit = () => 200;
    bodyForHit = (hit) => (hit === 1 ? JSON.stringify({ cities: [] }) : null);
    await expect(fetchCatalog(url).then(readCatalog)).rejects.toThrow('catalog response is not an array');
    const rows = await fetchCatalog(url).then(readCatalog);
    expect(hits).toBe(2);
    expect(rows).toEqual([CAMBRIDGE_POINT]);

    hits = 0;
    bodyForHit = () => JSON.stringify({ cities: [] });
    await expect(fetchCatalog(url).then(readCatalog)).rejects.toThrow('catalog response is not an array');
    expect(hits).toBe(1);
  });
});
