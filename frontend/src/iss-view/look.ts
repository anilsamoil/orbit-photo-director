import type { LookOffset } from '../iss-g1/model';
import type { CameraMode } from './model';

export type LookRoom = {
  radiusDeg: number;
  outwardDeg: number;
};

const DEFAULT_LIMB_DEG = 69.58;

/** Room to pan before Earth leaves the frame.
 *  `radiusDeg` is how far the boresight may turn from nadir. A wider field
 *  reaches the limb sooner, so that radius shrinks. `outwardDeg` is the
 *  extra turn past a horizon aim. A narrower field loses Earth in fewer
 *  degrees, so that room shrinks. */
export function lookRoom(
  verticalFovDeg: number,
  widthPx: number,
  heightPx: number,
  limbFromNadirDeg = DEFAULT_LIMB_DEG,
): LookRoom {
  const vertical = Number.isFinite(verticalFovDeg) && verticalFovDeg > 1 ? verticalFovDeg : 81.2;
  const horizontal = horizontalFovDeg(vertical, Math.max(widthPx, 1), Math.max(heightPx, 1));
  const half = Math.min(vertical, horizontal) / 2;
  const limb = Number.isFinite(limbFromNadirDeg) && limbFromNadirDeg > 1 ? limbFromNadirDeg : DEFAULT_LIMB_DEG;
  return {
    radiusDeg: limb - half * 0.35,
    outwardDeg: Math.max(0.4, half * 0.12),
  };
}

export function horizontalFovDeg(verticalDeg: number, widthPx: number, heightPx: number): number {
  const vertical = verticalDeg * Math.PI / 180;
  const aspect = heightPx > 0 ? widthPx / heightPx : 1;
  return 2 * Math.atan(Math.tan(vertical / 2) * aspect) * (180 / Math.PI);
}

export function nudgeLook(current: LookOffset, delta: LookOffset, mode: CameraMode, room: LookRoom): LookOffset {
  if (!Number.isFinite(delta.rightDeg) || !Number.isFinite(delta.upDeg)) return current;
  if (mode === 'nadir') return nudgeRadial(current, delta, room.radiusDeg);
  return {
    rightDeg: nudgeSigned(current.rightDeg, delta.rightDeg, room.radiusDeg),
    upDeg: nudgeHorizonUp(current.upDeg, delta.upDeg, room),
  };
}

export function settleLook(current: LookOffset, mode: CameraMode, room: LookRoom): LookOffset {
  if (mode === 'nadir') return scaleInside(current, room.radiusDeg);
  const rightDeg = clampAbs(current.rightDeg, room.radiusDeg);
  const upDeg = Math.min(room.radiusDeg, Math.max(-room.outwardDeg, current.upDeg));
  if (rightDeg === current.rightDeg && upDeg === current.upDeg) return current;
  return { rightDeg, upDeg };
}

function nudgeRadial(current: LookOffset, delta: LookOffset, limit: number): LookOffset {
  const next = { rightDeg: current.rightDeg + delta.rightDeg, upDeg: current.upDeg + delta.upDeg };
  const curMag = Math.hypot(current.rightDeg, current.upDeg);
  const nextMag = Math.hypot(next.rightDeg, next.upDeg);
  if (!(nextMag > curMag)) return next;
  const soft = softCeiling(nextMag, limit);
  if (soft === nextMag || !(nextMag > 0)) return next;
  const scale = soft / nextMag;
  return { rightDeg: next.rightDeg * scale, upDeg: next.upDeg * scale };
}

function nudgeSigned(current: number, delta: number, limit: number): number {
  const next = current + delta;
  if (Math.abs(next) <= Math.abs(current)) return next;
  if (current !== 0 && Math.sign(next) !== Math.sign(current)) return next;
  const sign = Math.sign(next || delta);
  return sign * softCeiling(Math.abs(next), limit);
}

function nudgeHorizonUp(current: number, delta: number, room: LookRoom): number {
  const next = current + delta;
  if (next >= 0 && current >= 0) {
    if (next <= current) return next;
    return softCeiling(next, room.radiusDeg);
  }
  if (next <= 0 && current <= 0) {
    if (next >= current) return next;
    return -softCeiling(-next, room.outwardDeg);
  }
  return next;
}

function softCeiling(mag: number, limit: number): number {
  if (!(limit > 0)) return 0;
  const knee = limit * 0.65;
  if (mag <= knee) return mag;
  const span = limit - knee;
  return knee + span * (1 - Math.exp(-(mag - knee) / span));
}

function scaleInside(offset: LookOffset, limit: number): LookOffset {
  const mag = Math.hypot(offset.rightDeg, offset.upDeg);
  if (!(mag > limit) || mag === 0) return offset;
  const scale = limit / mag;
  return { rightDeg: offset.rightDeg * scale, upDeg: offset.upDeg * scale };
}

function clampAbs(value: number, limit: number): number {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}
