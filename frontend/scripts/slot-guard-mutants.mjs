import ts from 'typescript';

const dock = "const dock=document.querySelector('.map-control-dock');";
const fixture = (name, source, extra = {}) => ({ name, clean: source.startsWith(dock) ? dock : '', files: { 'entry.ts': source, ...extra } });
const inline = (name, source) => fixture(name, `${dock}${source}`);
const styled = (name, source, css = '.r8-shift{translate:0 -80px}') =>
  fixture(name, `${dock}${source}`, { 'placement.css': css });

export const R8_PLACEMENT_MUTANTS = [
  inline('returned style member exact bag(dock).placement repro', "function bag(el){return {placement:el.style};}const placement=bag(dock).placement;placement.translate='0 -80px';"),
  inline('returned style member direct write', "function bag(el){return {x:el.style};}bag(dock).x.top='80px';"),
  inline('returned style member computed key alias', "const bag=el=>({x:el.style});const key='x';bag(dock)[key].top='80px';"),
  inline('returned arrow style member destructuring', "const bag=el=>({x:el.style});const {x}=bag(dock);x.translate='0 -80px';"),
  inline('returned element member direct write', "function bag(el){return {x:el};}bag(dock).x.style.top='80px';"),
  inline('returned arrow element member alias', "const bag=el=>({x:el});const element=bag(dock).x;element.style.translate='0 -80px';"),
  inline('returned element member destructuring', "function bag(el){return {x:el};}const {x}=bag(dock);x.style.top='80px';"),
  fixture('imported returned style member exact repro', `${dock}import {bag} from './helper';const placement=bag(dock).placement;placement.translate='0 -80px';`,
    { 'helper.ts': 'export function bag(el){return {placement:el.style};}' }),
  fixture('imported returned element member destructuring', `${dock}import {bag} from './helper';const {x}=bag(dock);x.style.top='80px';`,
    { 'helper.ts': 'export const bag=el=>({x:el});' }),
  inline('Reflect.set direct style', "Reflect.set(dock.style,'top','80px');"),
  inline('Reflect.set alias and dynamic property', "const s=dock.style;const prop=window.location.hash.slice(1);Reflect.set(s,prop,'80px');"),
  inline('Reflect.set element style attribute', "Reflect.set(dock,'style','top:80px');"),
  inline('Object.assign style placement', "Object.assign(dock.style,{top:'80px'});"),
  inline('Object.assign element style attribute', "Object.assign(dock,{style:'top:80px'});"),
  inline('aliased style setProperty', "const s=dock.style;s.setProperty('top','80px');"),
  inline('style cssText placement', "dock.style.cssText='top:80px';"),
  inline('style attribute direct assignment', "dock.style='translate:0 -80px';"),
  inline('setAttribute style placement', "dock.setAttribute('style','top:80px');"),
  styled('classList add placement CSS', "dock.classList.add('r8-shift');"),
  styled('classList add placement class-attribute CSS', "dock.classList.add('r8-shift');", '[class~="r8-shift"]{translate:0 -80px}'),
  styled('classList toggle placement CSS', "dock.classList.toggle('r8-shift',true);"),
  styled('classList replace placement CSS', "dock.classList.replace('old','r8-shift');"),
  styled('className placement CSS', "dock.className+=' r8-shift';"),
  styled('dataset placement CSS', "dock.dataset.r8Shift='yes';", '[data-r8-shift="yes"]{translate:0 -80px}'),
  styled('setAttribute placement CSS', "dock.setAttribute('data-r8-shift','yes');", '[data-r8-shift="yes"]{top:80px}'),
  styled('classList width placement CSS', "dock.classList.add('r8-shift');", '.r8-shift{width:600px}'),
  styled('classList height placement CSS', "dock.classList.add('r8-shift');", '.r8-shift{height:600px}'),
  fixture('CSSStyleSheet insertRule placement', "document.styleSheets[0].insertRule('.map-control-dock{top:80px}',0);"),
  fixture('CSSStyleSheet replace placement', "document.styleSheets[0].replace('.map-control-dock{translate:0 -80px}');"),
  fixture('CSSStyleSheet aliased replace placement', "const sheet=document.styleSheets[0];const css='.map-control-dock{translate:0 -80px}';sheet.replace(css);"),
  fixture('CSSStyleSheet replaceSync placement', "document.styleSheets[0].replaceSync('.map-control-dock{left:80px}');"),
  fixture('CSSStyleSheet reflected insertRule placement', "const sheet=document.styleSheets[0];sheet.insertRule.call(sheet,'.map-control-dock{translate:0 -80px}',0);"),
  fixture('constructed adopted stylesheet placement', "const sheet=new CSSStyleSheet();sheet.replaceSync('.map-control-dock{top:80px}');document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];"),
  fixture('imported adopted stylesheet escape', "import {sheet} from 'external-styles';document.adoptedStyleSheets=[sheet];"),
  fixture('injected style text placement', "const style=document.createElement('style');style.textContent='.map-control-dock{top:80px}';document.head.append(style);"),
  fixture('injected style innerHTML placement', "const style=document.createElement('style');style.innerHTML='.map-control-dock{translate:0 -80px}';document.head.appendChild(style);"),
  fixture('injected style append text placement', "const style=document.createElement('style');style.append('.map-control-dock{translate:0 -80px}');document.head.append(style);"),
  fixture('injected style appendChild text node placement', "const style=document.createElement('style');style.appendChild(document.createTextNode('.map-control-dock{translate:0 -80px}'));document.head.append(style);"),
  fixture('injected style insertAdjacentHTML placement', "document.head.insertAdjacentHTML('beforeend','<style>.map-control-dock{translate:0 -80px}</style>');"),
  inline('aliased animate keyframes', "const k=[{transform:'translateY(-80px)'}];dock.animate(k,100);"),
  fixture('imported animate keyframes', `${dock}import {keyframes as k} from './helper';dock.animate(k,100);`,
    { 'helper.ts': "export const keyframes=[{transform:'translateY(-80px)'}];" }),
  inline('returned animate keyframes', "function frames(){return [{transform:'translateY(-80px)'}];}dock.animate(frames(),100);"),
  inline('spread animate keyframes', "const frame={transform:'translateY(-80px)'};const k=[{...frame}];dock.animate([...k],100);"),
  inline('unanalysable animate keyframes', 'const k=window.externalFrames;dock.animate(k,100);'),
  inline('getAnimations setKeyframes placement', "const animation=dock.getAnimations()[0];const k=[{transform:'translateY(-80px)'}];animation.effect.setKeyframes(k);"),
  inline('KeyframeEffect aliased placement', "const k=[{transform:'translateY(-80px)'}];const effect=new KeyframeEffect(dock,k,100);new Animation(effect,document.timeline).play();"),
  inline('aliased KeyframeEffect constructor escape', "const Effect=KeyframeEffect;const k=[{transform:'translateY(-80px)'}];new Animation(new Effect(dock,k,100),document.timeline).play();"),
  inline('unknown constructor chrome style sink', 'new ExternalWriter(dock.style);'),
  inline('unknown chrome style sink', 'unknownWriter(dock.style);'),
  inline('unknown chrome element sink', 'unknownWriter(dock);'),
  inline('stored chrome style escape', 'window.externalBag={placement:dock.style};'),
  inline('exported returned chrome style escape', 'export function expose(){return dock.style;}'),
  inline('locally called exported chrome style escape', "export function expose(){return dock.style;}expose().opacity='0.5';"),
  inline('exported arrow returned chrome style escape', 'export const expose=()=>dock.style;'),
  fixture('forEach chrome collection placement', "const docks=document.querySelectorAll('.map-control-dock');docks.forEach(dock=>{dock.style.top='80px';});"),
  inline('bound placement method escape', "const write=dock.style.setProperty.bind(dock.style);write('top','80px');"),
  inline('called placement method escape', "const write=dock.style.setProperty;write.call(dock.style,'top','80px');"),
  inline('applied placement method escape', "const write=dock.style.setProperty;write.apply(dock.style,['top','80px']);"),
];

export const PLACEMENT_DIAGNOSTIC = /\b(?:placement|escape|animation|stylesheet)\b/i;

export function mutantSyntaxDiagnostics(files) {
  return Object.entries(files).filter(([name]) => name.endsWith('.ts')).flatMap(([fileName, source]) =>
    (ts.transpileModule(source, {
      fileName, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).diagnostics || []).map((error) => `${fileName}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`));
}
