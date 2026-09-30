/** MapLibre's first compact layout adds `maplibregl-compact-show`, which
 *  opens the credit line. That class arrives with the attribution text,
 *  after the map constructor returns. Removing it once leaves the info
 *  button collapsed. Later layout updates do not add it back. */
export function collapseAttribution(container: HTMLElement): void {
  let observer: MutationObserver | undefined;
  const collapse = (): boolean => {
    const node = container.querySelector('.maplibregl-ctrl-attrib');
    if (!node?.classList.contains('maplibregl-compact-show')) return false;
    observer?.disconnect();
    node.classList.remove('maplibregl-compact-show');
    return true;
  };
  if (collapse()) return;
  observer = new MutationObserver(() => {
    collapse();
  });
  observer.observe(container, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });
}
