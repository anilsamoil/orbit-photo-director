/** Every localStorage key the map owns. A feature reads and writes its entry
 *  here, so two features cannot collide on a key and one file lists what the
 *  map persists. */
export const PREF_KEYS = {
  cloudsVisible: 'opd-map-clouds-visible',
  irVisible: 'opd-map-ir-visible',
  selectedSatellites: 'opd-selected-satellites',
} as const;
