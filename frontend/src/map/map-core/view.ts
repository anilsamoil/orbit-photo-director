import type { Track } from '../../types';

export type SelectedSatellite = {
  readonly name: string;
  /** Three characters or fewer, for the topbar readout. */
  readonly label: string;
  readonly color: string;
  readonly track: Track;
};

export interface View {
  readonly track: Track | null;
  readonly satellites: readonly SelectedSatellite[];
}

export const EMPTY_VIEW: View = { track: null, satellites: [] };
