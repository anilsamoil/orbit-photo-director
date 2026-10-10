import { beforeEach, describe, expect, it } from 'vitest';
import { applyMapChrome, bindMapChrome, readMapChromeShown } from '../src/map-chrome';

function mount(): HTMLButtonElement {
  document.body.className = 'map-chrome-hidden';
  document.body.innerHTML = `
    <main id="view" class="view-map">
      <section id="map-pane" class="pane map-chrome-hidden">
        <button id="map-chrome-toggle" type="button" aria-expanded="false">Controls</button>
      </section>
    </main>
    <footer id="status-banner">Loading</footer>
  `;
  return document.getElementById('map-chrome-toggle') as HTMLButtonElement;
}

describe('map chrome', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts hidden and remembers show and hide on this device', () => {
    const button = mount();
    expect(readMapChromeShown()).toBe(false);
    bindMapChrome();
    expect(document.body.classList.contains('map-chrome-hidden')).toBe(true);
    expect(document.getElementById('map-pane')!.classList.contains('map-chrome-hidden')).toBe(true);
    expect(button.textContent).toBe('Controls');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('status-banner')!.textContent).toBe('Loading');

    button.click();
    expect(readMapChromeShown()).toBe(true);
    expect(document.body.classList.contains('map-chrome-hidden')).toBe(false);
    expect(button.textContent).toBe('Hide');
    expect(button.getAttribute('aria-expanded')).toBe('true');

    button.click();
    expect(localStorage.getItem('opd-map-chrome')).toBe('hidden');
    expect(button.textContent).toBe('Controls');

    localStorage.setItem('opd-map-chrome', 'shown');
    applyMapChrome(readMapChromeShown());
    expect(button.textContent).toBe('Hide');
    expect(document.getElementById('map-pane')!.classList.contains('map-chrome-hidden')).toBe(false);
  });

  it('leaves the dock scroll alone when the slots are unchanged', () => {
    const button = mount();
    const dock = document.createElement('div');
    dock.className = 'map-control-dock';
    document.getElementById('map-pane')!.appendChild(dock);
    bindMapChrome();
    dock.scrollLeft = 150;
    const toggle = document.body.classList.toggle.bind(document.body.classList);
    let writes = 0;
    document.body.classList.toggle = ((name: string, force?: boolean) => {
      writes += 1;
      return toggle(name, force);
    }) as typeof document.body.classList.toggle;
    (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome?.();
    expect(writes).toBe(0);
    expect(dock.scrollLeft).toBe(150);
    expect(button.textContent).toBe('Controls');
  });
});
