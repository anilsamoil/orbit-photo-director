const NARROW = '(max-width: 700px)';

export function bindLiveReadout(): void {
  const button = document.getElementById('live-readout-toggle');
  const panel = document.getElementById('live-readout');
  if (!(button instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) return;
  const narrow = window.matchMedia(NARROW);
  const apply = (): void => {
    const open = button.getAttribute('aria-expanded') === 'true';
    panel.hidden = narrow.matches && !open;
  };
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', open ? 'false' : 'true');
    apply();
  });
  narrow.addEventListener('change', apply);
  apply();
}
