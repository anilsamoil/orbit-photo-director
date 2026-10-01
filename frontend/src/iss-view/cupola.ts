import type { CameraMode } from './model';

export type CupolaWindow = {
  id: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  label: string;
  mode: CameraMode;
  /** Degrees from forward around nadir. Positive is starboard. Nadir is 0. */
  azimuthDeg: number;
};

/** Floor plan of the Cupola. Forward bisects windows 2 and 3. */
export const CUPOLA_WINDOWS: readonly CupolaWindow[] = [
  { id: 1, label: 'Window 1 · Port', mode: 'horizon', azimuthDeg: -90 },
  { id: 2, label: 'Window 2 · Forward port', mode: 'horizon', azimuthDeg: -30 },
  { id: 3, label: 'Window 3 · Forward starboard', mode: 'horizon', azimuthDeg: 30 },
  { id: 4, label: 'Window 4 · Starboard', mode: 'horizon', azimuthDeg: 90 },
  { id: 5, label: 'Window 5 · Aft starboard', mode: 'horizon', azimuthDeg: 150 },
  { id: 6, label: 'Window 6 · Aft port', mode: 'horizon', azimuthDeg: 210 },
  { id: 7, label: 'Window 7 · Nadir', mode: 'nadir', azimuthDeg: 0 },
];

export function cupolaPreset(id: number): { mode: CameraMode; azimuthDeg: number } | null {
  const found = CUPOLA_WINDOWS.find((entry) => entry.id === id);
  if (!found) return null;
  return { mode: found.mode, azimuthDeg: found.azimuthDeg };
}
