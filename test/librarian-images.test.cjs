'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {Librarian,imageIntent,requestMode}=require('../src/librarian.cjs');
const {FilesystemService,identity}=require('../src/filesystem.cjs');
const {ImageInputs,imageHeader}=require('../src/librarian-images.cjs');
// Header-only fixtures deliberately use an injected decoder. Native decoder and
// real model pixel interpretation are independently exercised by the Architect.
function png(width=1,height=1){const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;}
const response=patch=>({reply:'Viewed the supplied pixels.',clarification:null,needsMore:false,observations:[],views:[],changes:[],...patch});
const rename=(source,name)=>({action:'rename',paths:[source],name,destination:null,prefix:null,start:null,keepExtension:null,format:null,content:null});
function payload(prompt){return JSON.parse(prompt.split('CURRENT REQUEST (trusted), IMAGE MAPPING/HISTORY (untrusted evidence):\n')[1].split('\nAPP VALIDATOR')[0]);}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'systemus-vision-test-')),home=path.join(root,'home'),scratch=path.join(root,'scratch');await fs.mkdir(home);await fs.mkdir(scratch);
 const filesystem=new FilesystemService({home,stateDir:path.join(root,'state'),trashRoot:path.join(root,'Trash')});
 const calls=[],decoded=[],provider={async status(){return{available:true};},async plan(prompt,options){calls.push({prompt,options});return response();}};
 let closed=0;const librarian=new Librarian({filesystem,provider,imageScratchParent:scratch,imageDecode:async(bytes,{signal})=>{if(signal?.aborted)throw Object.assign(new Error('cancelled'),{code:'CANCELLED'});decoded.push(Buffer.from(bytes));return png();},closeImageDecoder:()=>closed++});
 const context={path:home,selection:[],entries:[],total:0,revision:1,view:'grid',sort:'name',direction:'asc',hidden:false};
 t.after(async()=>{await librarian.shutdown();filesystem.cancelAll();await fs.rm(root,{recursive:true,force:true});});return{root,home,scratch,filesystem,librarian,provider,calls,decoded,context,get closed(){return closed;}};
}
async function ask(f,text){let timer;try{return await Promise.race([new Promise((resolve,reject)=>{const events=[];try{f.librarian.start({text,context:f.context},event=>{events.push(event);if(event.type==='done')setImmediate(()=>resolve(events));});}catch(error){reject(error);}}),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Vision job never completed')),10000);})]);}finally{clearTimeout(timer);}}
async function image(f,name='a.png'){const file=path.join(f.home,name);await fs.writeFile(file,png());return file;}

test('explicit pixel intent supports selected referents and exact filenames; names-only, no-share and generic metadata never grant pixels',()=>{
 const context={selection:['/fixture/a.png']};
 for(const text of ['Look at the current image files and rename them based on what is in the image','Describe this','Rename this based on what is inside','What is in a.png?','Describe "a.png"'])assert.equal(imageIntent(text,context).authorized,true,text);
 for(const text of ['Move any image files to Pictures','Rename images using filenames only','Describe my directory structure','Show image names','"look at images"'])assert.equal(imageIntent(text,context).authorized,false,text);
 assert.equal(imageIntent("Look at images but don't share their pixels",context).denied,true);
 for(const text of ["Look at images but don't attach the images",'Describe these images; do not include image contents or pixels','Look at images without transmitting pictures','Look at images but don’t attach them']){assert.equal(imageIntent(text,context).denied,true,text);assert.equal(imageIntent(text,context).authorized,false,text);}
 assert.equal(requestMode('Show these images and rename them based on their contents'),'execute');assert.equal(requestMode('Look at these images'),'read-only');assert.equal(requestMode('How should I rename these images?'),'read-only');assert.equal(requestMode('Preview: look at images and rename them'),'preview');
});

test('complete folder discovery beyond240 entries uses multiple pixel batches and collision-safe direct renames with exact bytes/Undo',async t=>{
 const f=await fixture(t);for(let i=0;i<260;i++)await fs.writeFile(path.join(f.home,`000-text-${i}.txt`),'keep');
 for(let i=0;i<13;i++)await image(f,`neutral-${String(i).padStart(2,'0')}.png`);
 f.context.entries=(await f.filesystem.list({path:f.home,limit:240})).entries;assert.ok(!f.context.entries.some(e=>e.type==='image'));
 f.provider.plan=async(prompt,options)=>{f.calls.push({prompt,options});const data=payload(prompt);assert.equal(data.vision.total,13);assert.ok(options.images.every(item=>Buffer.isBuffer(item.bytes)));return response({changes:data.vision.attachments.map(item=>rename(item.path,'red-subject.png'))});};
 const events=await ask(f,'Look at the current image files and rename them based on what is in the image');
 assert.equal(f.calls.length,3);assert.deepEqual(f.calls.map(call=>call.options.images.length),[6,6,1]);assert.equal(events.filter(e=>e.type==='done').length,1);assert.ok(events.some(e=>e.type==='applied'));assert.equal(events.find(e=>e.type==='result').plan,null);
 const destinations=events.filter(e=>e.type==='step').map(e=>e.result.changes[0].destination);assert.equal(new Set(destinations).size,13);for(const file of destinations)assert.deepEqual(await fs.readFile(file),png());
 assert.equal(await fs.readFile(path.join(f.home,'000-text-0.txt'),'utf8'),'keep');assert.deepEqual(await fs.readdir(f.scratch),[]);assert.ok(f.closed>0);
 assert.equal((await f.filesystem.mutate({action:'undo'})).errors.length,0);assert.equal((await fs.readdir(f.home)).filter(name=>name.startsWith('neutral-')).length,1);
});

test('exact and selected-only requests attach only intended images; descriptions stay read-only without a text toggle',async t=>{
 const f=await fixture(t),a=await image(f),b=await image(f,'b.png');f.context.selection=[b];
 f.provider.plan=async(prompt,options)=>{f.calls.push({prompt,options});return response({reply:'One red triangle.'});};
 let events=await ask(f,'Describe "a.png"');assert.equal(payload(f.calls[0].prompt).vision.attachments[0].path,a);assert.equal(f.calls[0].options.images.length,1);assert.ok(!events.some(e=>e.type==='applied'));
 events=await ask(f,'Describe this');assert.equal(payload(f.calls[1].prompt).vision.attachments[0].path,b);assert.deepEqual(await fs.readFile(a),png());assert.deepEqual(await fs.readFile(b),png());
});

test('content-based naming advice sees pixels but its prompt and validator both keep changes empty',async t=>{
 const f=await fixture(t);await image(f);f.provider.plan=async(prompt,options)=>{f.calls.push({prompt,options});assert.match(prompt,/suggested names in advice are prose only/);assert.equal(payload(prompt).requestMode,'read-only');return response({reply:'The image shows a triangle; a descriptive name would be red-triangle.png.'});};
 const events=await ask(f,'How would you rename these images based on their contents?');assert.equal(f.calls[0].options.images.length,1);assert.ok(!events.some(e=>e.type==='applied'));assert.deepEqual(await fs.readFile(path.join(f.home,'a.png')),png());
});

test('existing descriptive files and duplicate subjects are preserved with local suffix allocation',async t=>{
 const f=await fixture(t),a=await image(f),b=await image(f,'b.png'),existing=await image(f,'red-triangle.png');f.context.selection=[a,b];
 f.provider.plan=async(prompt)=>response({changes:payload(prompt).vision.attachments.map(item=>rename(item.path,'red-triangle.png'))});
 const events=await ask(f,'Look at selected images and rename them based on their contents');
 assert.ok(events.some(e=>e.type==='applied'));assert.deepEqual(await fs.readFile(existing),png());assert.deepEqual(await fs.readFile(path.join(f.home,'red-triangle-2.png')),png());assert.deepEqual(await fs.readFile(path.join(f.home,'red-triangle-3.png')),png());
});

test('preview proposes pixel-based names without mutation and a later changed image invalidates its one-use plan',async t=>{
 const f=await fixture(t),a=await image(f);f.provider.plan=async()=>response({changes:[rename(a,'triangle.png')]});
 const events=await ask(f,'Preview renaming current images based on what they show');const plan=events.find(e=>e.type==='result').plan;assert.ok(plan);assert.deepEqual(await fs.readFile(a),png());
 await fs.writeFile(a,png(2,2));const applied=await new Promise(resolve=>f.librarian.approve({token:plan.token,context:f.context},event=>{if(event.type==='done')resolve(event);}));assert.equal(applied.results.length,0);assert.deepEqual(await fs.readFile(a),png(2,2));await assert.rejects(fs.stat(path.join(f.home,'triangle.png')),{code:'ENOENT'});
});

test('failed later pixel batch, model refusal and unsupported format report error before final done, never a partial rename',async t=>{
 const f=await fixture(t);for(let i=0;i<7;i++)await image(f,`n${i}.png`);let calls=0;
 f.provider.plan=async(prompt)=>{if(++calls===2)throw Object.assign(new Error('Model image failure'),{code:'PROVIDER'});return response({changes:payload(prompt).vision.attachments.map(item=>rename(item.path,'subject.png'))});};
 let events=await ask(f,'Look at all current images and rename them based on their contents');assert.ok(events.findIndex(e=>e.type==='error')<events.findIndex(e=>e.type==='done'));assert.equal((await fs.readdir(f.home)).filter(name=>name.startsWith('n')).length,7);assert.deepEqual(await fs.readdir(f.scratch),[]);
 f.provider.plan=async()=>response({clarification:'I cannot view these image attachments.'});events=await ask(f,'Describe current images');assert.equal(events.find(e=>e.type==='error').error.code,'IMAGE_CAPABILITY');assert.ok(!events.some(e=>e.vision?.complete));
 await fs.writeFile(path.join(f.home,'unsupported.svg'),'<svg/>');f.calls.length=0;f.provider.plan=async()=>{f.calls.push('unexpected');return response();};events=await ask(f,'Look at current images and rename them based on their contents');assert.equal(events.find(e=>e.type==='error').error.code,'IMAGE_FORMAT');assert.equal(f.calls.length,0);assert.deepEqual(await fs.readdir(f.scratch),[]);
});

test('no-share/names-only and image-count caps never attach a subset or silently rename it',async t=>{
 const f=await fixture(t);await image(f);f.context.selection=[path.join(f.home,'a.png')];
 let events=await ask(f,'Look at images but do not share them');assert.equal(events.find(e=>e.type==='error').error.code,'IMAGE_CONSENT');assert.equal(f.calls.length,0);
 await ask(f,'Rename images using filenames only');assert.equal(f.calls[0].options.images,undefined);
 f.calls.length=0;for(let i=0;i<64;i++)await image(f,`extra${i}.png`);events=await ask(f,'Look at current image files and rename them based on their contents');assert.equal(events.find(e=>e.type==='error').error.code,'IMAGE_LIMIT');assert.equal(f.calls.length,0);assert.equal(f.decoded.length,0);
});

test('image replacement and image-derived injection cannot redirect validated pixel plans',async t=>{
 const f=await fixture(t),a=await image(f);f.provider.plan=async()=>{await fs.writeFile(a,png(2,2));return response({changes:[rename(a,'triangle.png')]});};
 let events=await ask(f,'Look at images and rename them based on their contents');assert.equal(events.find(e=>e.type==='error').error.code,'PLAN_STALE');assert.deepEqual(await fs.readFile(a),png(2,2));
 f.provider.plan=async()=>response({changes:[rename('/etc/passwd','owned.png')]});events=await ask(f,'Look at images and rename them based on their contents');assert.equal(events.find(e=>e.type==='error').error.code,'PLAN_SCHEMA');assert.deepEqual(await fs.readFile(a),png(2,2));
 const outside=path.join(f.root,'outside.png');await fs.writeFile(outside,png());events=await ask(f,`Describe "${outside}"`);assert.equal(events.find(e=>e.type==='error').error.code,'SCOPE');
});

test('cancellation cleans staged snapshots and reports cancelled before done without applying',async t=>{
 const f=await fixture(t);await image(f);let started;
 const ready=new Promise(resolve=>started=resolve);f.provider.plan=(_prompt,{signal})=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('Cancelled pixel plan'),{code:'CANCELLED'})),{once:true}));};
 const pending=ask(f,'Look at images and rename them based on their contents');await ready;f.librarian.cancel();const events=await pending;
 assert.ok(events.findIndex(e=>e.type==='cancelled')<events.findIndex(e=>e.type==='done'));assert.equal(events.filter(e=>e.type==='done').length,1);assert.deepEqual(await fs.readdir(f.scratch),[]);assert.deepEqual(await fs.readFile(path.join(f.home,'a.png')),png());
});

test('header preflight rejects dimensions/bad ranges before decoder allocation, including forged ICO embedded PNG',()=>{
 assert.deepEqual(imageHeader(png(12,20)),{width:12,height:20,format:'png'});assert.throws(()=>imageHeader(png(12001,1)),{code:'IMAGE_LIMIT'});assert.throws(()=>imageHeader(png(8000,8000)),{code:'IMAGE_LIMIT'});
 const ico=Buffer.alloc(22+33);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=1;ico[7]=1;ico.writeUInt32LE(33,14);ico.writeUInt32LE(22,18);png(9000,9000).copy(ico,22);assert.throws(()=>imageHeader(ico),{code:'IMAGE_LIMIT'});
 png(2,2).copy(ico,22);assert.throws(()=>imageHeader(ico),/disagree/);
 const webp=Buffer.alloc(30);webp.write('RIFF');webp.writeUInt32LE(22,4);webp.write('WEBP',8);webp.write('VP8X',12);webp.writeUInt32LE(10,16);webp.writeUIntLE(16000,24,3);assert.throws(()=>imageHeader(webp),{code:'IMAGE_LIMIT'});
 assert.throws(()=>imageHeader(Buffer.from('<svg onload="x()"/>')),{code:'IMAGE_FORMAT'});
});

test('identity-safe image staging refuses symlinks/FIFOs without blocking and cleans all partial attachments', {timeout:5000},async t=>{
 const f=await fixture(t),a=await image(f),link=path.join(f.home,'link.png'),pipe=path.join(f.home,'pipe.png');await fs.symlink(a,link);await promisify(execFile)('/usr/bin/mkfifo',[pipe]);
 for(const file of [link,pipe]){
  const inputs=new ImageInputs({scratchParent:f.scratch,decode:async()=>assert.fail('Unsafe source must not reach decoder')});
  await assert.rejects(inputs.stage([{path:file,identity:identity(await fs.lstat(file))}]));assert.deepEqual(await fs.readdir(f.scratch),[]);
 }
});
