const painted = new WeakMap<HTMLElement, string>();

/** D-DIN digits do not share an advance, and the font has no tabular-nums
 *  feature. Each digit and separator sits in a fixed cell so a ticking
 *  readout does not shove the characters beside it. */
export function paintEqualDigits(el: HTMLElement, text: string): void {
  if (painted.get(el) === text) return;
  painted.set(el, text);
  const fragment = document.createDocumentFragment();
  for (const char of text) {
    if (char >= '0' && char <= '9') {
      const cell = document.createElement('span');
      cell.className = 'digit';
      cell.textContent = char;
      fragment.append(cell);
      continue;
    }
    if (char === ':' || char === '.' || char === ',') {
      const cell = document.createElement('span');
      cell.className = 'digit-sep';
      cell.textContent = char;
      fragment.append(cell);
      continue;
    }
    fragment.append(document.createTextNode(char));
  }
  el.replaceChildren(fragment);
}
