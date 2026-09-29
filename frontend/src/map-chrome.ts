const STORAGE_KEY = 'opd-map-chrome';

export function readMapChromeShown(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'shown';
  } catch {
    return false;
  }
}

export function applyMapChrome(shown: boolean): void {
  document.body.classList.toggle('map-chrome-hidden', !shown);
  document.getElementById('map-pane')?.classList.toggle('map-chrome-hidden', !shown);
  const button = document.getElementById('map-chrome-toggle');
  if (!(button instanceof HTMLButtonElement)) return;
  button.setAttribute('aria-expanded', shown ? 'true' : 'false');
  button.textContent = shown ? 'Hide' : 'Controls';
  button.title = shown ? 'Hide map controls' : 'Show map controls';
}

export function bindMapChrome(): void {
  applyMapChrome(readMapChromeShown());
  document.getElementById('map-chrome-toggle')?.addEventListener('click', () => {
    const shown = document.body.classList.contains('map-chrome-hidden');
    try {
      localStorage.setItem(STORAGE_KEY, shown ? 'shown' : 'hidden');
    } catch {
    }
    applyMapChrome(shown);
  });
}
