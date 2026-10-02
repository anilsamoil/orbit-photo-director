const DRAG_START_PX = 8;

export function bindTopbarPan(bar: HTMLElement | null): void {
  if (!bar) return;
  let pointerId = -1;
  let originX = 0;
  let originScroll = 0;
  let dragging = false;
  let suppressClick = false;

  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (bar.scrollWidth > bar.clientWidth + 1) event.stopPropagation();
    suppressClick = false;
    pointerId = event.pointerId;
    originX = event.clientX;
    originScroll = bar.scrollLeft;
    dragging = false;
  });

  bar.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - originX;
    if (!dragging) {
      if (Math.abs(dx) < DRAG_START_PX) return;
      dragging = true;
      if (typeof bar.setPointerCapture === 'function') bar.setPointerCapture(event.pointerId);
    }
    bar.scrollLeft = originScroll - dx;
    event.preventDefault();
  });

  const end = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerId = -1;
    if (dragging) suppressClick = true;
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}
