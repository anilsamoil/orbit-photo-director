import type { CameraMode } from './model';

/** The cupola plate, looking Earthward, puts port at 12 o'clock and
 *  starboard opposite. Forward sits between windows 2 and 3. Aft sits
 *  between windows 5 and 6. Window 7 is the center nadir pane.
 *  Side windows have no camera preset. The plate does not supply a
 *  clock-to-body azimuth. */
export type CupolaWindow = {
  id: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  label: string;
  preset: CameraMode | null;
};

export const CUPOLA_WINDOWS: readonly CupolaWindow[] = [
  { id: 1, label: 'Window 1 · Port · Coming soon', preset: null },
  { id: 2, label: 'Window 2 · Forward port · Coming soon', preset: null },
  { id: 3, label: 'Window 3 · Forward starboard · Coming soon', preset: null },
  { id: 4, label: 'Window 4 · Starboard · Coming soon', preset: null },
  { id: 5, label: 'Window 5 · Aft starboard · Coming soon', preset: null },
  { id: 6, label: 'Window 6 · Aft port · Coming soon', preset: null },
  { id: 7, label: 'Window 7 · Nadir', preset: 'nadir' },
];

export function cupolaPreset(id: number): CameraMode | null {
  const found = CUPOLA_WINDOWS.find((entry) => entry.id === id);
  return found ? found.preset : null;
}
