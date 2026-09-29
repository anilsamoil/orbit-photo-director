import { describe, expect, it } from 'vitest';
import { bindTopbarPan } from '../src/topbar-pan';

function pointer(type: string, x: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, pointerId: 1, button: 0, buttons: 1 });
}

describe('top bar pan', () => {
  it('scrolls when a drag starts on the Kp chip and leaves a tap as a click', () => {
    document.body.innerHTML = `
      <header class="topbar">
        <button id="kp-widget" type="button">Kp 3.0</button>
        <button id="tab-queue" type="button">Queue</button>
      </header>
    `;
    const bar = document.querySelector<HTMLElement>('.topbar')!;
    const kp = document.getElementById('kp-widget')!;
    bindTopbarPan(bar);
    let clicks = 0;
    kp.addEventListener('click', () => {
      clicks += 1;
    });

    kp.dispatchEvent(pointer('pointerdown', 180));
    bar.dispatchEvent(pointer('pointermove', 40));
    bar.dispatchEvent(pointer('pointerup', 40));
    expect(bar.scrollLeft).toBe(140);

    kp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clicks).toBe(0);

    kp.dispatchEvent(pointer('pointerdown', 180));
    kp.dispatchEvent(pointer('pointerup', 180));
    kp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clicks).toBe(1);
    expect(bar.scrollLeft).toBe(140);
  });
});
