function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function clipsOverflow(style) {
  const axes = [style.overflowX, style.overflowY, style.overflow];
  return axes.some((value) => value === 'hidden' || value === 'auto' || value === 'scroll' || value === 'clip');
}

/** Intersect the column port with every overflow-clipping ancestor of el up through column. */
export function clipPortFor(el, column, getStyle = (node) => getComputedStyle(node)) {
  let port = column.getBoundingClientRect();
  let node = el;
  while (node) {
    if (node.nodeType === 1 && clipsOverflow(getStyle(node))) {
      port = intersect(port, node.getBoundingClientRect());
    }
    if (node === column) break;
    node = node.parentElement;
  }
  return port;
}

/** True when every non-empty text Range rect sits inside the clip port. */
export function textVisibleInPort(textRects, port, slack = 1) {
  const rects = (textRects || []).filter((box) => box.width > 0 && box.height > 0);
  if (!rects.length) return false;
  return rects.every((box) => (
    box.top >= port.top - slack
    && box.bottom <= port.bottom + slack
    && box.left >= port.left - slack
    && box.right <= port.right + slack
  ));
}

/**
 * Verdict for one side-column selector.
 * elementBoxInside alone must not pass when text is clipped (status-clip / later-cascade).
 */
export function sideColumnTextVerdict(sample) {
  const elementInside = sample.elementBox
    && sample.elementBox.height > 1
    && sample.elementVisible >= sample.elementBox.height - 1;
  const port = sample.port;
  if (!port || port.height < 1 || port.width < 1) {
    return { ok: false, step: 'clipped', reason: 'port', sel: sample.sel };
  }
  const textOk = textVisibleInPort(sample.textRects, port);
  if (!textOk) {
    return {
      ok: false,
      step: 'clipped',
      reason: 'text',
      sel: sample.sel,
      elementInside: !!elementInside,
    };
  }
  return { ok: true, sel: sample.sel, elementInside: !!elementInside };
}

export function sideColumnReachVerdict(samples) {
  for (const sample of samples) {
    const verdict = sideColumnTextVerdict(sample);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** Page-side helpers shared with SIDE_COLUMN_REACH. */
export function sideColumnReachReaders() {
  return `${intersect.toString()}
${clipsOverflow.toString()}
${clipPortFor.toString()}
${textVisibleInPort.toString()}
function textRectsOf(el) {
  if (!(el instanceof HTMLElement)) return [];
  const range = document.createRange();
  range.selectNodeContents(el);
  return [...range.getClientRects()].map((box) => ({
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    width: box.width,
    height: box.height,
  }));
}
function elementVisibleHeight(el, column) {
  const box = el.getBoundingClientRect();
  const port = column.getBoundingClientRect();
  return Math.max(0, Math.min(box.bottom, port.bottom) - Math.max(box.top, port.top));
}
function textFits(el, column) {
  const port = clipPortFor(el, column);
  const textRects = textRectsOf(el);
  if (!(el.textContent || '').trim()) return false;
  return textVisibleInPort(textRects, port);
}
`;
}

export function statusClipMutantSample() {
  const column = { left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 };
  const elementBox = { left: 8, top: 300, right: 192, bottom: 320, width: 184, height: 20 };
  return {
    sel: '[data-iss-status]',
    elementBox,
    elementVisible: 20,
    port: { left: 8, top: 300, right: 192, bottom: 310, width: 184, height: 10 },
    textRects: [
      { left: 8, top: 300, right: 180, bottom: 318, width: 172, height: 18 },
    ],
    column,
  };
}

export function laterCascadeMutantSample() {
  const column = { left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 };
  return [
    {
      sel: '[data-iss-launch-name]',
      elementBox: { left: 8, top: 10, right: 192, bottom: 30, width: 184, height: 20 },
      elementVisible: 20,
      port: column,
      textRects: [{ left: 8, top: 10, right: 160, bottom: 28, width: 152, height: 18 }],
    },
    {
      sel: '[data-iss-edition]',
      elementBox: { left: 8, top: 200, right: 192, bottom: 240, width: 184, height: 40 },
      elementVisible: 40,
      port: { left: 8, top: 200, right: 192, bottom: 220, width: 184, height: 20 },
      textRects: [
        { left: 8, top: 200, right: 180, bottom: 216, width: 172, height: 16 },
        { left: 8, top: 218, right: 140, bottom: 234, width: 132, height: 16 },
      ],
    },
  ];
}

export function healthySideColumnSamples() {
  const column = { left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 };
  return ['[data-iss-launch-name]', '[data-iss-status]', '[data-iss-edition]'].map((sel, index) => {
    const top = 20 + index * 40;
    return {
      sel,
      elementBox: { left: 8, top, right: 192, bottom: top + 20, width: 184, height: 20 },
      elementVisible: 20,
      port: column,
      textRects: [{ left: 8, top, right: 160, bottom: top + 18, width: 152, height: 18 }],
    };
  });
}
