import { afterEach, describe, expect, it, vi } from 'vitest';

import { isRosterProfile, rosterProfiles, rosterSites } from '../src/crew-roster';
import type { PersonalTarget } from '../src/profile';

function sitesOf(name: string): readonly PersonalTarget[] {
  if (!isRosterProfile(name)) throw new Error(`${name} is not a roster profile`);
  return rosterSites(name);
}

function siteRows(name: string): (string | number)[][] {
  return sitesOf(name).map((site) => [site.id, site.name, site.lat, site.lon, site.priority]);
}

describe('crew roster registry', () => {
  it('lists the three roster profiles in roster.json order', () => {
    expect(rosterProfiles()).toEqual([
      { name: 'watkins', displayName: 'Jessica Watkins (Watty)' },
      { name: 'kutryk', displayName: 'Josh Kutryk' },
      { name: 'delaney', displayName: 'Luke Delaney' },
    ]);
  });

  it('owns the three roster names and no other profile name', () => {
    expect(['anil', 'watkins', 'jessica', 'kutryk', 'josh', 'delaney'].filter(isRosterProfile)).toEqual(['watkins', 'kutryk', 'delaney']);
  });

  it('reads the 12 Watkins sites verbatim from watkins.csv', () => {
    expect(siteRows('watkins')).toEqual([
      ['personal:watkins:lafayette-colorado-hometown', 'Lafayette, Colorado hometown', 39.994, -105.09, 5],
      ['personal:watkins:boulder-and-the-flatirons-colorado', 'Boulder and the Flatirons, Colorado', 40.015, -105.271, 4],
      ['personal:watkins:south-san-francisco-bay-stanford-and-moffett-field', 'South San Francisco Bay, Stanford and Moffett Field', 37.444, -122.16, 4],
      ['personal:watkins:los-angeles-basin-ucla-and-pasadena', 'Los Angeles basin, UCLA and Pasadena', 34.054, -118.243, 4],
      ['personal:watkins:hanksville-and-mars-desert-research-station-terrain-utah', 'Hanksville and Mars Desert Research Station terrain, Utah', 38.405, -110.79, 5],
      ['personal:watkins:florida-keys-aquarius-and-conch-reef', 'Florida Keys, Aquarius and Conch Reef', 24.95, -80.453, 5],
      ['personal:watkins:grand-canyon-arizona', 'Grand Canyon, Arizona', 36.308, -112.293, 5],
      ['personal:watkins:yosemite-valley-and-central-sierra-nevada-california', 'Yosemite Valley and central Sierra Nevada, California', 37.733, -119.606, 4],
      ['personal:watkins:death-valley-california', 'Death Valley, California', 36.47, -117.088, 5],
      ['personal:watkins:houston-and-galveston-bay-texas', 'Houston and Galveston Bay, Texas', 29.57, -94.937, 3],
      ['personal:watkins:cape-canaveral-and-kennedy-space-center-coastline-florida', 'Cape Canaveral and Kennedy Space Center coastline, Florida', 28.607, -80.604, 3],
      ['personal:watkins:dubai-united-arab-emirates', 'Dubai, United Arab Emirates', 25.265, 55.292, 4],
    ]);
  });

  it('reads the 11 Kutryk sites verbatim from kutryk.csv', () => {
    expect(siteRows('kutryk')).toEqual([
      ['personal:kutryk:beauvallon-and-eastern-alberta-farmland-oblique-only', 'Beauvallon and eastern Alberta farmland (oblique only)', 53.659, -111.366, 5],
      ['personal:kutryk:fort-saskatchewan-and-north-saskatchewan-river-oblique-only', 'Fort Saskatchewan and North Saskatchewan River (oblique only)', 53.713, -113.215, 4],
      ['personal:kutryk:cold-lake-and-its-lakeshore-city-oblique-only', 'Cold Lake and its lakeshore city (oblique only)', 54.531, -110.066, 5],
      ['personal:kutryk:saguenay-fjord-and-la-baie', 'Saguenay Fjord and La Baie', 48.33, -70.869, 4],
      ['personal:kutryk:kingston-waterfront-and-royal-military-college-setting', 'Kingston waterfront and Royal Military College setting', 44.231, -76.481, 4],
      ['personal:kutryk:rogers-dry-lake-and-edwards-region', 'Rogers Dry Lake and Edwards region', 34.935, -117.833, 5],
      ['personal:kutryk:houston-clear-lake-and-galveston-bay-region', 'Houston Clear Lake and Galveston Bay region', 29.578, -95.131, 4],
      ['personal:kutryk:mistastin-lake-also-called-kamestastin-oblique-only', 'Mistastin Lake, also called Kamestastin (oblique only)', 55.89, -63.269, 5],
      ['personal:kutryk:slovenian-karst-and-divaca-region-caves-connection', 'Slovenian Karst and Divača region, CAVES connection', 45.683, 13.969, 4],
      ['personal:kutryk:meteor-crater-arizona', 'Meteor Crater, Arizona', 35.027, -111.018, 5],
      ['personal:kutryk:cape-canaveral-and-florida-space-coast', 'Cape Canaveral and Florida Space Coast', 28.451, -80.528, 4],
    ]);
  });

  it('reads the 11 Delaney sites verbatim from delaney.csv', () => {
    expect(siteRows('delaney')).toEqual([
      ['personal:delaney:debary-st-johns-river-and-lake-monroe-florida', 'DeBary, St. Johns River and Lake Monroe, Florida', 28.883, -81.309, 5],
      ['personal:delaney:cape-canaveral-and-kennedy-space-center-coast-florida', 'Cape Canaveral and Kennedy Space Center coast, Florida', 28.451, -80.528, 5],
      ['personal:delaney:university-of-north-florida-and-jacksonville-florida', 'University of North Florida and Jacksonville, Florida', 30.269, -81.51, 5],
      ['personal:delaney:miami-and-biscayne-bay-florida', 'Miami and Biscayne Bay, Florida', 25.774, -80.194, 4],
      ['personal:delaney:hampton-and-hampton-roads-virginia', 'Hampton and Hampton Roads, Virginia', 37.026, -76.344, 5],
      ['personal:delaney:patuxent-river-mouth-and-southern-chesapeake-bay-maryland', 'Patuxent River mouth and southern Chesapeake Bay, Maryland', 38.318, -76.456, 4],
      ['personal:delaney:quantico-region-and-potomac-river-virginia', 'Quantico region and Potomac River, Virginia', 38.522, -77.291, 4],
      ['personal:delaney:pensacola-bay-and-gulf-barrier-islands-florida', 'Pensacola Bay and Gulf barrier islands, Florida', 30.368, -87.201, 4],
      ['personal:delaney:corpus-christi-bay-and-padre-island-coast-texas', 'Corpus Christi Bay and Padre Island coast, Texas', 27.786, -97.258, 4],
      ['personal:delaney:san-diego-bay-and-pacific-coastline-california', 'San Diego Bay and Pacific coastline, California', 32.65, -117.134, 4],
      ['personal:delaney:okinawa-island-and-adjacent-reefs-japan', 'Okinawa island and adjacent reefs, Japan', 26.475, 127.912, 5],
    ]);
  });

  it('stamps every site with one fixed creation time', () => {
    expect(sitesOf('watkins')[0]).toEqual({
      id: 'personal:watkins:lafayette-colorado-hometown',
      name: 'Lafayette, Colorado hometown',
      lat: 39.994,
      lon: -105.09,
      priority: 5,
      createdAt: '2026-10-05T00:00:00.000Z',
    });
    expect(new Set(rosterProfiles().flatMap((profile) => rosterSites(profile.name).map((site) => site.createdAt)))).toEqual(
      new Set(['2026-10-05T00:00:00.000Z']),
    );
  });
});

describe('crew roster import cycle', () => {
  it.each([
    ['profile', () => import('../src/profile')],
    ['profile-session', () => import('../src/profile-session')],
    ['crew-roster', () => import('../src/crew-roster')],
    ['csv-parse', () => import('../src/csv-parse')],
  ])('loads roster sites when %s is imported first', async (_first, importFirst) => {
    vi.resetModules();
    await importFirst();
    const { loadProfile } = await import('../src/profile');
    expect(loadProfile('delaney')?.additions[10]?.id).toBe('personal:delaney:okinawa-island-and-adjacent-reefs-japan');
  });
});

describe('crew roster registry over broken files', () => {
  const ROSTER = [
    { name: 'watkins', displayName: 'Jessica Watkins (Watty)' },
    { name: 'kutryk', displayName: 'Josh Kutryk' },
    { name: 'delaney', displayName: 'Luke Delaney' },
  ];
  const mockedPaths: string[] = [];

  async function rosterWith(files: Record<string, string>): Promise<typeof import('../src/crew-roster')> {
    vi.resetModules();
    for (const [file, text] of Object.entries(files)) {
      const path = `../../data/crew-roster/${file}?raw`;
      vi.doMock(path, () => ({ default: text }));
      mockedPaths.push(path);
    }
    return import('../src/crew-roster');
  }

  afterEach(() => {
    for (const path of mockedPaths.splice(0)) vi.doUnmock(path);
    vi.resetModules();
  });

  it('refuses a roster entry with no CSV', async () => {
    const roster = await rosterWith({ 'roster.json': JSON.stringify([...ROSTER, { name: 'tremblay', displayName: 'Jenni Gibbons' }]) });
    expect(() => roster.rosterProfiles()).toThrow('crew roster: tremblay has no tremblay.csv');
  });

  it('refuses a CSV with no roster entry', async () => {
    const roster = await rosterWith({ 'roster.json': JSON.stringify(ROSTER.slice(0, 2)) });
    expect(() => roster.rosterProfiles()).toThrow('crew roster: delaney.csv has no roster.json entry');
  });

  it('refuses a CSV whose header is not name,lat,lon,priority and lists no other profile', async () => {
    const roster = await rosterWith({ 'watkins.csv': 'site,latitude,longitude\r\nGrand Canyon,36.308,-112.293\r\n' });
    expect(() => roster.rosterProfiles()).toThrow('crew roster: watkins.csv has invalid_header');
    expect(() => roster.isRosterProfile('kutryk')).toThrow('crew roster: watkins.csv has invalid_header');
  });

  it('refuses a row the CSV parser rejects', async () => {
    const roster = await rosterWith({ 'kutryk.csv': 'name,lat,lon,priority\nMeteor Crater,35.027,-111.018,5\nCold Lake,95,-110.066,5\n' });
    expect(() => roster.rosterProfiles()).toThrow('crew roster: kutryk.csv line 3 is lat_out_of_range');
  });

  it('refuses a site name with no letter or digit to make an id from', async () => {
    const roster = await rosterWith({ 'delaney.csv': 'name,lat,lon,priority\n沖縄,26.475,127.912,5\n' });
    expect(() => roster.rosterProfiles()).toThrow('crew roster: delaney.csv line 2 has no letter or digit to make an id');
  });

  it('refuses two site names that make one id', async () => {
    const roster = await rosterWith({ 'watkins.csv': 'name,lat,lon,priority\n"Grand Canyon, Arizona",36.308,-112.293,5\nGrand Canyon Arizona,36.1,-112.1,4\n' });
    expect(() => roster.rosterProfiles()).toThrow('crew roster: watkins.csv line 3 repeats the site id grand-canyon-arizona');
  });
});
