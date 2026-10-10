import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  jsPlacementViolations, ownerPlacementViolations, projectPlacementViolations,
  REINTRODUCTION_PATTERNS, reintroductionMisses,
} from '../scripts/census-narrow-chrome.mjs';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function project(files: Record<string, string>): string {
  const root = mkdtempSync(resolve('.slot-guard-test-'));
  scratch.push(root);
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

describe('slot placement ownership (fu211)', () => {
  it.each(['map-controls', 'map-controls-time', 'map-controls-bearing', 'map-controls-filter', 'map-controls-overlay'])(
    'rejects the exact owned-prefix %s escape', (actor) => {
      expect(ownerPlacementViolations(`body.map-slot-owned .view-map .${actor}{position:absolute!important;top:80px!important;right:16px!important}`)).not.toEqual([]);
      expect(ownerPlacementViolations(`body.map-slot-owned .view-map .${actor}{position:static!important;top:auto!important;right:auto!important}`)).toEqual([]);
    },
  );

  it.each([
    'inset-block-start:80px', 'inset-inline-end:16px', 'inset-block:80px auto',
    'translate:0 80px', 'transform:translateY(80px)', 'margin:80px 0 0', 'margin-inline-start:16px',
    'top:var(--unallocated-y)', 'animation:escape 1s',
  ])('rejects non-slot placement through %s', (decl) => {
    expect(ownerPlacementViolations(`body.map-slot-owned .view-map .map-controls-time{${decl}}`)).not.toEqual([]);
  });

  it('accepts only the matching actor slot and harmless resets', () => {
    const owned = '.view-map .map-command';
    expect(ownerPlacementViolations(`${owned}{position:absolute;left:var(--slot-time-x);top:var(--slot-time-y);right:auto;bottom:auto;margin:0;transform:none;translate:none;inset-block:auto}`)).toEqual([]);
    expect(ownerPlacementViolations(`${owned}{position:absolute;left:var(--slot-dock-x);top:var(--slot-time-y)}`)).not.toEqual([]);
    expect(ownerPlacementViolations(`${owned}{position:absolute}`)).not.toEqual([]);
    expect(ownerPlacementViolations(':is(.map-command,.map-control-dock){position:absolute;left:var(--slot-time-x);top:var(--slot-time-y)}')).not.toEqual([]);
    expect(ownerPlacementViolations(':where(.map-command,.map-control-dock){position:static;left:auto;top:auto}')).toEqual([]);
    expect(ownerPlacementViolations('body.map-slot-owned .map-controls{position:absolute;left:var(--slot-time-x);top:var(--slot-time-y)}')).not.toEqual([]);
  });

  it('catches attributes, selector lists and conditional rules without selector-name trust', () => {
    for (const selector of ['[class~="map-controls"]', '[id="map-command"]', ':is(.map-controls-time)', '.unrelated, .map-controls-overlay']) {
      expect(ownerPlacementViolations(`@media (width < 900px){body.map-slot-owned .view-map ${selector}{inset-inline-start:24px}}`)).not.toEqual([]);
    }
  });

  it('rejects CSS/JS second slot writers and placement animation', () => {
    expect(ownerPlacementViolations('body{--slot-time-y:80px}')).not.toEqual([]);
    expect(jsPlacementViolations('document.body.style.setProperty("--slot-time-y", "80px");', { owner: false })).not.toEqual([]);
    expect(jsPlacementViolations('document.body.style.cssText += "--slot-time-y:80px";', { owner: false })).not.toEqual([]);
    expect(jsPlacementViolations('function otherLayout(m) { return solveChromeSlots(m); }')).not.toEqual([]);
    expect(jsPlacementViolations('function otherLayout() { writeSlot("--slot-time-y", 80); }')).not.toEqual([]);
    expect(jsPlacementViolations('el.animate([{ translate:"0 0" }, { translate:"0 80px" }], 1);')).not.toEqual([]);
  });

  it('accepts only created hidden/noninteractive probes, not names that look like probes', () => {
    const hidden = `function measure(){const probe=document.createElement('div');probe.style.visibility='hidden';probe.style.pointerEvents='none';probe.style.left='0';probe.style.top='0';}`;
    expect(jsPlacementViolations(hidden)).toEqual([]);
    expect(jsPlacementViolations(hidden.replace("probe.style.visibility='hidden';", ''))).not.toEqual([]);
    expect(jsPlacementViolations(hidden.replace("document.createElement('div')", "document.querySelector('.map-controls')"))).not.toEqual([]);
    expect(jsPlacementViolations("probe.style.top='80px';")).not.toEqual([]);
    expect(jsPlacementViolations("el.style.top='auto';el.style.position='static';el.style.margin='0';el.style.translate='none';")).toEqual([]);
  });

  it('accepts a hidden clone whose measurement styles are applied as a property map', () => {
    expect(jsPlacementViolations(`function measure(node){
      const copy=node.cloneNode(true);
      const styles={position:'fixed',left:'0',top:'0',visibility:'hidden','pointer-events':'none'};
      for(const [property,value] of Object.entries(styles)) copy.style.setProperty(property,value,'important');
    }`)).toEqual([]);
  });

  it('examines imported CSS and JS beyond the original owner files', () => {
    const root = project({
      'src/style.css': '@import "./extra.css";',
      'src/main.ts': 'import "./extra";',
      'src/extra.css': 'body.map-slot-owned .map-controls{top:80px}',
      'src/extra.ts': 'const controls=document.querySelector(".map-controls"); controls.style.translate="0 80px";',
      'src/other.ts': 'const thumbnail=document.createElement("img");thumbnail.style.top="80px";',
    });
    const errors = projectPlacementViolations(root);
    expect(errors.some((error) => error.startsWith('src/extra.css:'))).toBe(true);
    expect(errors.some((error) => error.startsWith('src/extra.ts:'))).toBe(true);
    expect(errors.some((error) => error.startsWith('src/other.ts:'))).toBe(false);
  });

  it('catches every mutation in the shared proof catalog', () => {
    expect(REINTRODUCTION_PATTERNS.length).toBeGreaterThanOrEqual(30);
    expect(reintroductionMisses()).toEqual([]);
  });
});
