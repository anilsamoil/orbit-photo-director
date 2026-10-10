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

  it.each([
    `const placement=dock.style;placement.top='0px';`,
    `const {style:placement}=dock;placement.top='0px';`,
    `const {['style']:placement}=dock;placement.top='0px';`,
    `const {style}=dock;style.translate='0 80px';`,
    `let placement;placement=dock.style;placement.insetBlockStart='0px';`,
    `let placement;({style:placement}=dock);placement.setProperty('top','0px');`,
    `const element=dock;const first=element.style;const placement=first;placement['left']='0px';`,
    `const placement=(dock as HTMLElement).style;Object.assign(placement,{top:'0px'});`,
    `const placement=dock.style;placement.cssText='top:0px';`,
    `const placement=dock.style;const property='top';placement[property]='0px';`,
    `const {style:{setProperty:put}}=dock;put.call(dock.style,'top','0px');`,
    `const [placement]=[dock.style];placement.top='0px';`,
  ])('rejects style alias placement with element provenance: %s', (write) => {
    const source = `const dock=document.querySelector('.map-control-dock');${write}`;
    expect(jsPlacementViolations(source, { owner: false })).not.toEqual([]);
    expect(jsPlacementViolations(source.replace('.map-control-dock', '.thumbnail'), { owner: false })).toEqual([]);
  });

  it('retains selector provenance through assignment and literal aliases', () => {
    expect(jsPlacementViolations(`
      const selector='.map-control-dock';let dock;dock=document.querySelector(selector);
      const {style:placement}=dock;placement.top='0px';
    `, { owner: false })).not.toEqual([]);
  });

  it('retains element provenance when the style alias is exported and imported', () => {
    const root = project({
      'src/main.ts': `import {placement as s} from './extra';s.top='0px';`,
      'src/extra.ts': `export const {style:placement}=document.querySelector('.map-control-dock');`,
    });
    expect(projectPlacementViolations(root)).toContain('src/main.ts: js inline placement: top');
  });

  it('does not confuse equally named aliases in different imported modules', () => {
    const root = project({
      'src/main.ts': `import './owned';import './unrelated';`,
      'src/owned.ts': `const dock=document.querySelector('.map-control-dock');const s=dock.style;s.top='0px';`,
      'src/unrelated.ts': `const dock=document.querySelector('.thumbnail');const s=dock.style;s.top='0px';`,
    });
    expect(projectPlacementViolations(root)).toEqual(['src/owned.ts: js inline placement: top']);
  });

  it('tracks aliases by lexical binding, including destructured hidden probes', () => {
    expect(jsPlacementViolations(`
      const dock=document.querySelector('.map-control-dock');
      function thumbnail(){const dock=document.createElement('img');const {style:s}=dock;s.top='0px';}
    `, { owner: false })).toEqual([]);
    expect(jsPlacementViolations(`
      function measure(){const probe=document.createElement('div');const {style:s}=probe;
        s.visibility='hidden';s.pointerEvents='none';s.top='0px';}
    `)).toEqual([]);
    expect(jsPlacementViolations(`
      function measure(){const probe=document.createElement('div');const {style:s}=probe;
        s.visibility='hidden';s.pointerEvents='none';s.top='0px';}
      function escape(){const probe=document.querySelector('.map-control-dock');const {style:s}=probe;s.top='0px';}
    `, { owner: false })).not.toEqual([]);
  });

  it('allows aliased harmless resets but rejects aliased slot writers on any element', () => {
    expect(jsPlacementViolations(`
      const {style:s}=document.querySelector('.map-control-dock');
      s.top='auto';s.position='static';s.margin='0';s.translate='none';
    `, { owner: false })).toEqual([]);
    expect(jsPlacementViolations(`const s=document.body.style;s.setProperty('--slot-time-y','80px');`, { owner: false })).not.toEqual([]);
    expect(jsPlacementViolations(`const {style:s}=document.body;s.cssText+='--slot-time-y:80px';`, { owner: false })).not.toEqual([]);
  });

  it.each([
    `export function move(){const dock=document.querySelector('.map-control-dock');const s=dock.style;s.top='0px';}`,
    `export function move(){const {style:s}=document.querySelector('.map-control-dock');s.top='0px';}`,
    `export function move(dock){const {style:s}=dock;s.top='0px';}`,
    `export function move({style:s}){s.top='0px';}`,
    `export function move(dock){write(dock.style);}function write(s){s.setProperty('top','0px');}`,
  ])('rejects an imported and called aliased style writer: %s', (writer) => {
    const root = project({
      'src/main.ts': `import {move as relocate} from './extra';relocate(document.querySelector('.map-control-dock'));`,
      'src/extra.ts': writer,
    });
    expect(projectPlacementViolations(root)).toContain('src/extra.ts: js inline placement: top');
  });

  it('catches every mutation in the shared proof catalog', () => {
    expect(REINTRODUCTION_PATTERNS.length).toBeGreaterThanOrEqual(30);
    expect(reintroductionMisses()).toEqual([]);
  });
});
