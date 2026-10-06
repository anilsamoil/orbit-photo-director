type LegendDisclosure = 'collapsed' | 'expanded';

function readLegendDisclosure(button: HTMLButtonElement): LegendDisclosure {
  return button.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed';
}

function applyLegendDisclosure(button: HTMLButtonElement, state: LegendDisclosure): void {
  button.setAttribute('aria-expanded', state === 'expanded' ? 'true' : 'false');
}

export function bindLegendDisclosure(root?: ParentNode | null): void {
  const scope = root ?? document;
  const legend = scope.querySelector('#map-legend');
  const button = scope.querySelector('#map-legend-toggle');
  if (!(legend instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return;
  const collapse = () => applyLegendDisclosure(button, 'collapsed');
  collapse();
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
    applyLegendDisclosure(button, readLegendDisclosure(button) === 'expanded' ? 'collapsed' : 'expanded');
  });
  window.addEventListener('pageshow', collapse);
}
