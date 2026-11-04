import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRasterOcr, clearRasterOcrRun, countryRasterUrls, ocrFrame, ocrPython, ocrRasterTile, rasterWords, readableRasterName, rasterOcrStats } from './raster-ocr.mjs';

const moduleUrl = new URL('./raster-ocr.mjs', import.meta.url).href;
function subprocess(env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {checkRasterOcr} from ${JSON.stringify(moduleUrl)};checkRasterOcr();`], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 100000 });
}
function labelPng(text, width=256) {
  const script = `from PIL import Image,ImageDraw,ImageFont\nimport io,sys\nim=Image.new('RGBA',(${width},256),'white')\nfonts=['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']\nfrom pathlib import Path\nf=ImageFont.truetype(next(p for p in fonts if Path(p).exists()),28)\nImageDraw.Draw(im).text((90,90),sys.argv[1],font=f,fill='black')\nb=io.BytesIO();im.save(b,format='PNG');sys.stdout.buffer.write(b.getvalue())`;
  const result=spawnSync(ocrPython(), ['-c',script,text], { maxBuffer: 2*1024*1024 });
  assert.equal(result.status,0,result.stderr?.toString());return result.stdout;
}

test('doctor actually reads known text, and fails closed for missing OCR dependencies', () => {
  assert.equal(checkRasterOcr().ok,true);
  const dir=mkdtempSync(join(tmpdir(),'opd-ocr-deps-'));
  try {
    const broken=join(dir,'broken');writeFileSync(broken,'#!/bin/sh\nexit 19\n');chmodSync(broken,0o700);
    assert.notEqual(subprocess({OPD_VERIFY_OCR_PYTHON:broken}).status,0,'missing Pillow must fail');
    assert.notEqual(subprocess({OPD_VERIFY_TESSERACT:join(dir,'missing')}).status,0,'missing tesseract must fail');
    assert.notEqual(subprocess({TESSDATA_PREFIX:dir}).status,0,'missing English data must fail');
    assert.notEqual(subprocess({OPD_VERIFY_TESSERACT:broken}).status,0,'nonzero tesseract must fail');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('adjacent raster pixels are stitched before OCR, and full glyph bounds must fit unoccluded viewport', () => {
  const bytes=labelPng('AUSTRALIA',512);
  const cut=`from PIL import Image\nimport io,sys,base64,json\nim=Image.open(io.BytesIO(sys.stdin.buffer.read()))\na=[]\nfor x in [0,256]:\n b=io.BytesIO();im.crop((x,0,x+256,256)).save(b,format='PNG');a.append(base64.b64encode(b.getvalue()).decode())\nprint(json.dumps(a))`;
  // Put the lettering across the tile seam, not merely two OCR strings.
  const shifted=spawnSync(ocrPython(),['-c',`from PIL import Image\nimport io,sys\nim=Image.open(io.BytesIO(sys.stdin.buffer.read()));out=Image.new('RGBA',im.size,'white');out.paste(im,(105,0));b=io.BytesIO();out.save(b,format='PNG');sys.stdout.buffer.write(b.getvalue())`],{input:bytes});
  const parts=JSON.parse(spawnSync(ocrPython(),['-c',cut],{input:shifted.stdout,encoding:'utf8'}).stdout);
  const result=ocrRasterTile(parts.map((part,x)=>({x,y:0,bytes:Buffer.from(part,'base64')})));
  assert.match(result.text,/AUSTRALIA/);
  const pack={mosaics:[{...result,z:1,service:'fixture'}]};
  const viewport={width:512,height:256,scale:1,origin:{x:0,y:0},occlusions:[]};
  assert.equal(readableRasterName(pack,{viewport},'Australia').readable,true);
  assert.equal(readableRasterName(pack,{viewport:{...viewport,width:256}},'Australia').readable,false);
  assert.equal(readableRasterName(pack,{viewport:{...viewport,occlusions:[[0,0,512,256]]}},'Australia').readable,false);
});

test('two cold runs re-fetch changed bytes at the same URL and produce changed OCR', async () => {
  let bytes=labelPng('AUSTRALIA'), requests=0;
  const server=createServer((req,res)=>{requests++;res.writeHead(200,{'content-type':'image/png'});res.end(bytes);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/fixture/tile/0/0/0`;
    clearRasterOcrRun();const first=await rasterWords([url]);assert.match(first.text,/AUSTRALIA/);
    bytes=labelPng('OCEAN');clearRasterOcrRun();const second=await rasterWords([url]);
    assert.match(second.text,/OCEAN/);assert.doesNotMatch(second.text,/AUSTRALIA/);
    assert.equal(requests,2);assert.equal(rasterOcrStats.calls,1);
    assert.notEqual(first.mosaics[0].hash,second.mosaics[0].hash);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('bounded OCR retains sovereign-name context instead of accepting state or ocean fragments', () => {
  const word=(text,x)=>({text,uppercase:true,box:[x,10,x+40,20]});
  const viewport={width:400,height:100,scale:1,origin:{x:0,y:0},occlusions:[]};
  const pack=lines=>({mosaics:[{z:0,service:'fixture',lines,words:lines.flat()}]});
  assert.equal(readableRasterName(pack([[word('SOUTH',10),word('AUSTRALIA',55)]]),{viewport},'Australia').readable,false);
  assert.equal(readableRasterName(pack([[word('INDIAN',10),word('OCEAN',55)]]),{viewport},'India').readable,false);
  assert.equal(readableRasterName(pack([[word('GREAT',10),word('AUSTRALIAN',55),word('BIGHT',100)],[word('AUSTRALIA',10)]]),{viewport},'Australia').readable,true);
});


test('glyph scale follows the drawn tile, not round(zoom + 1) past the source cap', () => {
  const word = { text: 'FRANCE', uppercase: true, box: [10, 10, 80, 40] };
  const pack = { mosaics: [{ z: 6, service: 'reference', lines: [[word]], words: [word] }] };
  const staleScale = (512 * (2 ** 6.5)) / (256 * (2 ** 8));
  const row = {
    zoom: 6.5,
    viewport: { width: 100, height: 100, scale: staleScale, origin: { x: 0, y: 0 }, occlusions: [] },
  };
  assert.equal(readableRasterName(pack, row, 'France').readable, false);
});

test('the python helper is resolved from the module path when vitest rewrites the page URL', async () => {
  const source = readFileSync(new URL('./raster-ocr.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new\s+URL\(\s*['"]\.\/raster-ocr\.py['"]\s*,\s*import\.meta\.url\s*\)/);
  const { rasterHelperFrom } = await import('./raster-ocr.mjs');
  const modulePath = fileURLToPath(new URL('./raster-ocr.mjs', import.meta.url));
  const helper = fileURLToPath(new URL('./raster-ocr.py', import.meta.url));
  assert.equal(typeof rasterHelperFrom, 'function');
  assert.equal(rasterHelperFrom(`http://127.0.0.1:42700/@fs${modulePath}`), helper);
  assert.equal(rasterHelperFrom(pathToFileURL(modulePath).href), helper);
});

test('centroid neighborhoods only select already rendered URLs and retain seam neighbors', () => {
  const urls=[];
  for(let y=0;y<8;y++)for(let x=0;x<8;x++)urls.push(`https://tiles.invalid/reference/tile/3/${y}/${x}`);
  const selected=countryRasterUrls(urls,{lng:134,lat:-25});
  assert.equal(selected.length,9);
  assert.ok(selected.includes('https://tiles.invalid/reference/tile/3/4/6'));
  assert.ok(selected.includes('https://tiles.invalid/reference/tile/3/4/7'));
  const available=selected.filter(url=>!url.endsWith('/4/7'));
  assert.deepEqual(countryRasterUrls(available,{lng:134,lat:-25}),available,'missing offscreen neighbor must never be fetched or manufactured');
});

test('a stuck tesseract is killed with its session and does not hold the node timeout', () => {
  const source = readFileSync(new URL('./raster-ocr.mjs', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./raster-ocr.py', import.meta.url), 'utf8');
  assert.match(source, /OPD_VERIFY_OCR_PASS_TIMEOUT \|\| 60/);
  assert.match(source, /passes \* seconds \* 1000 \+ 20000/);
  assert.doesNotMatch(helper, /'stdin', 'stdout'/);
  assert.match(helper, /start_new_session=True/);
  assert.match(helper, /os\.killpg\(proc\.pid, signal\.SIGKILL\)/);
  assert.match(helper, /os\.path\.realpath\(path\)/);
  assert.match(helper, /signal\.signal\(signal\.SIGTERM, _stop_child\)/);
  assert.match(source, /runHelper\(\['--crops'\], input, pngs\.length/);
  const dir = mkdtempSync(join(tmpdir(), 'opd-ocr-hang-'));
  const fake = join(dir, 'tesseract');
  const pidfile = join(dir, 'pid');
  writeFileSync(fake, `#!/bin/sh\necho $$ > ${JSON.stringify(pidfile)}\ntrap '' TERM INT\nsleep 30\n`);
  chmodSync(fake, 0o700);
  const previous = {
    tesseract: process.env.OPD_VERIFY_TESSERACT,
    timeout: process.env.OPD_VERIFY_OCR_PASS_TIMEOUT,
    pid: process.env.OPD_OCR_PIDFILE,
  };
  process.env.OPD_VERIFY_TESSERACT = fake;
  process.env.OPD_VERIFY_OCR_PASS_TIMEOUT = '1';
  process.env.OPD_OCR_PIDFILE = pidfile;
  const started = Date.now();
  try {
    assert.throws(() => ocrFrame(labelPng('KENYA')), /tesseract timed out/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 8000, `hung for ${elapsed}ms`);
    const pid = readFileSync(pidfile, 'utf8').trim();
    assert.notEqual(spawnSync('kill', ['-0', pid]).status, 0, 'the tesseract session was still alive');
  } finally {
    if (previous.tesseract === undefined) delete process.env.OPD_VERIFY_TESSERACT;
    else process.env.OPD_VERIFY_TESSERACT = previous.tesseract;
    if (previous.timeout === undefined) delete process.env.OPD_VERIFY_OCR_PASS_TIMEOUT;
    else process.env.OPD_VERIFY_OCR_PASS_TIMEOUT = previous.timeout;
    if (previous.pid === undefined) delete process.env.OPD_OCR_PIDFILE;
    else process.env.OPD_OCR_PIDFILE = previous.pid;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(ocrFrame(labelPng('KENYA')).text, /KENYA/);
});

test('tesseract receives the real path when the temp directory is a symlink', () => {
  const real = mkdtempSync(join(tmpdir(), 'opd-ocr-real-'));
  const link = join(tmpdir(), `opd-ocr-link-${process.pid}`);
  symlinkSync(real, link);
  const fake = join(real, 'tesseract');
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in\n  ${link}/*) echo "unresolved $1" >&2; exit 2;;\nesac\nexec "$(command -v tesseract)" "$@"\n`);
  chmodSync(fake, 0o700);
  const previous = { tmp: process.env.TMPDIR, tesseract: process.env.OPD_VERIFY_TESSERACT };
  process.env.TMPDIR = link;
  process.env.OPD_VERIFY_TESSERACT = fake;
  try {
    assert.match(ocrFrame(labelPng('KENYA')).text, /KENYA/);
  } finally {
    if (previous.tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous.tmp;
    if (previous.tesseract === undefined) delete process.env.OPD_VERIFY_TESSERACT;
    else process.env.OPD_VERIFY_TESSERACT = previous.tesseract;
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('the outer timeout kills the tesseract child', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opd-ocr-outer-'));
  const fake = join(dir, 'tesseract');
  const pidfile = join(dir, 'pid');
  const frame = join(dir, 'frame.png');
  writeFileSync(fake, `#!/bin/sh\necho $$ > ${JSON.stringify(pidfile)}\ntrap '' TERM INT\nsleep 30\n`);
  chmodSync(fake, 0o700);
  writeFileSync(frame, labelPng('KENYA'));
  const helper = fileURLToPath(new URL('./raster-ocr.py', import.meta.url));
  const started = Date.now();
  const result = spawnSync(ocrPython(), [helper, '--frame', frame], {
    encoding: 'utf8',
    timeout: 2000,
    killSignal: 'SIGTERM',
    env: { ...process.env, OPD_VERIFY_TESSERACT: fake, OPD_VERIFY_OCR_PASS_TIMEOUT: '30' },
  });
  try {
    assert.ok(Date.now() - started < 8000, `outer wait lasted ${Date.now() - started}ms`);
    assert.ok(result.error && result.error.code === 'ETIMEDOUT');
    const pid = readFileSync(pidfile, 'utf8').trim();
    assert.notEqual(spawnSync('kill', ['-0', pid]).status, 0, 'tesseract survived the outer timeout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
