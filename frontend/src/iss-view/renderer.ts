import type { ScenePose } from '../iss-g1/model';
import type { ImageryState } from './model';

export type IssAim = {
  pose: ScenePose;
  verticalFovDeg: number;
  widthPx: number;
  heightPx: number;
  lightingUtcMs: number;
};

export type IssRendererHooks = {
  onImagery: (note: ImageryState) => void;
  onContextLost: () => void;
};

export type IssRenderer = {
  ready(): Promise<void>;
  aim(aim: IssAim): Promise<void>;
  resize(widthPx: number, heightPx: number): void;
  destroy(): void;
};

export type IssRendererFactory = (frame: HTMLElement, hooks: IssRendererHooks) => IssRenderer;
