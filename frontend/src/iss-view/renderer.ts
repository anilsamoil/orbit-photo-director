import type { ScenePose } from '../iss-g1/model';
import type { LaunchSite, LaunchVisibility } from './launches';
import type { ImageryState } from './model';

export type IssAim = {
  pose: ScenePose;
  verticalFovDeg: number;
  widthPx: number;
  heightPx: number;
  lightingUtcMs: number;
  fovEpoch?: number;
  onCamera?: (appliedFovDeg: number, fovEpoch: number, rollDeg?: number) => void;
};

export type IssRendererHooks = {
  onImagery: (note: ImageryState) => void;
  onContextLost: () => void;
  onLaunchLook?: (eventId: string) => void;
  onLaunchVisibility?: (eventId: string, visibility: LaunchVisibility) => void;
};

export type IssRendererOptions = {
  labels?: boolean;
};

export type IssRenderer = {
  ready(): Promise<void>;
  aim(aim: IssAim): Promise<void>;
  showLaunches?(sites: readonly LaunchSite[]): void;
  resize(widthPx: number, heightPx: number): void;
  destroy(): void;
};

export type IssRendererFactory = (
  frame: HTMLElement,
  hooks: IssRendererHooks,
  options?: IssRendererOptions,
) => IssRenderer;
