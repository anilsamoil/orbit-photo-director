type LegendDisclosure = 'collapsed' | 'expanded';

const LEGEND_WARNING_MARKS = ['feed unavailable', 'LIVE now (not the scrubbed time)'];

function readLegendDisclosure(button: HTMLButtonElement): LegendDisclosure {
  return button.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed';
}

function applyLegendDisclosure(button: HTMLButtonElement, state: LegendDisclosure): void {
  button.setAttribute('aria-expanded', state === 'expanded' ? 'true' : 'false');
}

function legendWarningText(imagery: Element | null): string {
  const text = imagery?.textContent?.trim() ?? '';
  if (!text) return '';
  return LEGEND_WARNING_MARKS.some((mark) => text.includes(mark)) ? text : '';
}

function warningDot(button: HTMLButtonElement): HTMLElement {
  const existing = button.querySelector('.map-legend-warning-dot');
  if (existing instanceof HTMLElement) return existing;
  const dot = document.createElement('span');
  dot.className = 'map-legend-warning-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.hidden = true;
  button.appendChild(dot);
  return dot;
}

function warningNote(legend: HTMLElement): HTMLElement {
  const existing = legend.querySelector('#map-legend-warning');
  if (existing instanceof HTMLElement) return existing;
  const note = document.createElement('span');
  note.id = 'map-legend-warning';
  note.className = 'map-legend-warning';
  note.hidden = true;
  legend.appendChild(note);
  return note;
}

function syncLegendWarning(legend: HTMLElement, button: HTMLButtonElement): void {
  const text = legendWarningText(legend.querySelector('.map-imagery-date'));
  const dot = warningDot(button);
  const note = warningNote(legend);
  if (!text) {
    dot.hidden = true;
    note.hidden = true;
    note.textContent = '';
    button.removeAttribute('aria-describedby');
    return;
  }
  note.textContent = text;
  note.hidden = false;
  dot.hidden = false;
  button.setAttribute('aria-describedby', 'map-legend-warning');
}

export function bindLegendDisclosure(root?: ParentNode | null): void {
  const scope = root ?? document;
  const legend = scope.querySelector('#map-legend');
  const button = scope.querySelector('#map-legend-toggle');
  if (!(legend instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return;
  const collapse = () => applyLegendDisclosure(button, 'collapsed');
  collapse();
  const sync = () => syncLegendWarning(legend, button);
  sync();
  const imagery = legend.querySelector('.map-imagery-date');
  if (imagery) {
    const observer = new MutationObserver(sync);
    observer.observe(imagery, { childList: true, characterData: true, subtree: true });
  }
  button.addEventListener('click', () => {
    applyLegendDisclosure(button, readLegendDisclosure(button) === 'expanded' ? 'collapsed' : 'expanded');
    button.focus({ preventScroll: true });
  });
  legend.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (readLegendDisclosure(button) !== 'expanded') return;
      event.preventDefault();
      collapse();
      return;
    }
    if (event.target !== button || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    if (event.repeat) return;
    applyLegendDisclosure(button, readLegendDisclosure(button) === 'expanded' ? 'collapsed' : 'expanded');
  });
  window.addEventListener('pageshow', collapse);
}
