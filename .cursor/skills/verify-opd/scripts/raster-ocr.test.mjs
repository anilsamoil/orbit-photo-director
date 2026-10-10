import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRasterOcr, clearRasterOcrRun, ocrPython, ocrRasterTile, rasterWords, readableRasterName, rasterOcrStats } from './raster-ocr.mjs';

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
