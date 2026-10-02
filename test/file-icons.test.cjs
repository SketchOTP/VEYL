'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {FileIcons}=require('../src/file-icons.cjs');
const {catalog,families}=require('../src/file-type-catalog.cjs');
const {validateSpec,validateIcons}=require('../src/file-icon-schema.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const response=keys=>({icons:keys.map(key=>({key,spec:clone(families.design)}))});
async function fixture(t,options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'systemus-icons-test-'));
 const icons=new FileIcons({stateDir:path.join(root,'state'),debounce:60_000,...options});
 t.after(async()=>{await icons.shutdown();await fs.rm(root,{recursive:true,force:true});});
 await icons.initialize();return{root,icons};
}
async function renderer(){const source=await fs.readFile(path.join(__dirname,'../src/renderer/file-type-icons.js'),'utf8');return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));}

test('catalog has distinct known types, recognizable families, compound archives and extensionless names',()=>{
 const keys=['txt','md','json','csv','css','html','js','py','sh','pdf','docx','xlsx','pptx','mp3','mp4','zip','deb','ttf','blend'].map(ext=>'ext:'+ext).concat('name:dockerfile');
 assert.equal(new Set(keys.map(key=>JSON.stringify(catalog[key]))).size,keys.length);
 for(const key of keys)assert.ok(catalog[key],key);
 assert.notDeepEqual(families.text,families.markdown);assert.notDeepEqual(families.audio,families.video);
 for(const spec of Object.values(families))validateSpec(spec);
 assert.equal(catalog['ext:tar.gz'].family,'archive');assert.equal(catalog['file:extensionless'].badge,'FILE');
});

test('declarative validation rejects executable strings, unexpected keys, unsafe coordinates and mismatched batch keys',()=>{
 const key='ext:novel',valid=response([key]);assert.deepEqual(validateIcons(valid,[key]),valid);
 const variants=[
  {...valid,svg:'<svg onload="alert(1)"/>'},
  {icons:[{key,spec:{shapes:[{...families.text.shapes[0],kind:'script'}]}}]},
  {icons:[{key,spec:{shapes:[{...families.text.shapes[0],fill:'url(https://example.invalid)'}]}}]},
  {icons:[{key,spec:{shapes:[{...families.text.shapes[0],x:'0;alert(1)'}]}}]},
  {icons:[{key,spec:{shapes:[{...families.text.shapes[0],x:49}]}}]},
  {icons:[{key,spec:{shapes:[{...families.text.shapes[0],style:'background:red'}]}}]},
  {icons:[{key:'ext:other',spec:families.text}]},
  {icons:[{key:'ext:../../secret',spec:families.text}]},
  {icons:[{key,spec:{shapes:Array(15).fill(families.text.shapes[0])}}]}
 ];
 for(const value of variants)assert.throws(()=>validateIcons(value,[key]),{code:'ICON_SCHEMA'});
 const out=clone(valid);out.icons[0].spec.shapes[0].points[0].x=Infinity;assert.throws(()=>validateIcons(out,[key]),{code:'ICON_SCHEMA'});
 assert.throws(()=>validateIcons({icons:[valid.icons[0],valid.icons[0]]},[key,'ext:other']),{code:'ICON_SCHEMA'});
});

test('known types do not call the provider; unknown keys deduplicate in bounded six-type batches and persist across restart',async t=>{
 const calls=[],f=await fixture(t,{provider:{async designIcons(keys){calls.push([...keys]);return response(keys);}}});
 const keys=Array.from({length:8},(_,i)=>'ext:new'+i);
 f.icons.resolve(['ext:txt','ext:md','name:dockerfile','file:extensionless',...keys,...keys]);
 await f.icons.pump();await f.icons.pump();
 assert.deepEqual(calls,[keys.slice(0,6),keys.slice(6)]);
 assert.equal(f.icons.boot().records.length,8);assert.ok(f.icons.boot().records.every(r=>r.state==='generated'&&r.persisted));
 const saved=await fs.readFile(path.join(f.icons.stateDir,'file-icons.json'),'utf8');assert.ok(!saved.includes('persisted'));
 let reruns=0;const resumed=new FileIcons({stateDir:f.icons.stateDir,provider:{async designIcons(){reruns++;throw new Error('Cached types must not call AI');}}});
 t.after(()=>resumed.shutdown());await resumed.initialize();
 assert.ok(resumed.resolve(keys).every(r=>r.state==='generated'&&r.persisted));await resumed.pump();assert.equal(reruns,0);
});

test('active type is not requeued while generating, and foreground chat pauses/restarts the single background job',async t=>{
 let calls=0,aborts=0,release;
 const f=await fixture(t,{provider:{designIcons(keys,{signal}){calls++;return new Promise((resolve,reject)=>{release=()=>resolve(response(keys));signal.addEventListener('abort',()=>{aborts++;reject(Object.assign(new Error('paused'),{code:'CANCELLED'}));},{once:true});});}}});
 f.icons.resolve(['ext:newone']);const first=f.icons.pump();f.icons.resolve(['ext:newone','ext:newone']);assert.equal(f.icons.queue.size,0);
 await f.icons.pause();await first;assert.equal(aborts,1);assert.equal(f.icons.records.get('ext:newone').attempts,0);
 let busy=true;f.icons.isBusy=()=>busy;await f.icons.pump();assert.equal(calls,1);
 busy=false;const second=f.icons.pump();release();await second;await f.icons.pump();assert.equal(calls,2);assert.equal(f.icons.records.get('ext:newone').status,'generated');
});

test('failures persist bounded retry/backoff and resume other queued batches without chat',async t=>{
 let now=1_000,calls=0;const f=await fixture(t,{now:()=>now,provider:{async designIcons(keys){calls++;if(calls===1||keys.includes('ext:retry'))throw Object.assign(new Error('offline'),{code:'PROVIDER'});return response(keys);}}});
 const first=['ext:retry',...Array.from({length:6},(_,i)=>'ext:fail'+i)];f.icons.resolve(first);await f.icons.pump();await f.icons.pump();
 assert.equal(calls,2);assert.equal(f.icons.records.get('ext:fail5').status,'generated');
 f.icons.resolve(['ext:retry']);await f.icons.pump();assert.equal(calls,2);
 now+=24*60*60*1000;f.icons.resolve(['ext:retry']);await f.icons.pump();assert.equal(calls,3);assert.equal(f.icons.records.get('ext:retry').attempts,2);
 now+=24*60*60*1000;f.icons.resolve(['ext:retry']);await f.icons.pump();assert.equal(calls,3);
 const resumed=new FileIcons({stateDir:f.icons.stateDir,now:()=>now,provider:{designIcons(){assert.fail('Exhausted retry must survive relaunch');}}});t.after(()=>resumed.shutdown());await resumed.initialize();resumed.resolve(['ext:retry']);await resumed.pump();assert.equal(resumed.boot().records.find(r=>r.key==='ext:retry').state,'failed');
});

test('failed cache write is reported as session-only, and generated state is not falsely called persisted',async t=>{
 const updates=[],f=await fixture(t,{provider:{async designIcons(keys){return response(keys);}},emit:event=>updates.push(event)});
 await fs.writeFile(f.icons.stateDir,'occupied');f.icons.resolve(['ext:nocache']);await f.icons.pump();
 const generated=updates.at(-1);assert.equal(generated.state,'generated');assert.equal(generated.persisted,false);assert.match(generated.cacheWarning,/could not be saved/);assert.match(generated.message,/session icon/);
});

test('session/record caps remain explicit and shutdown cancels only one active design job',async t=>{
 let calls=0,aborted=0;const f=await fixture(t,{maxRecords:2,maxNew:1,provider:{designIcons(_keys,{signal}){calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(Object.assign(new Error('cancelled'),{code:'CANCELLED'}));},{once:true}));}}});
 assert.equal(f.icons.resolve(['ext:first','ext:second'])[1].state,'limited');const pending=f.icons.pump();await f.icons.shutdown();await pending;
 assert.equal(calls,1);assert.equal(aborted,1);assert.equal(f.icons.queue.size,0);f.icons.resolve(['ext:third']);await f.icons.pump();assert.equal(calls,1);
});

test('a worst-case valid generated spec cannot write a registry exceeding its relaunch read budget',async t=>{
 const shape={kind:'polygon',points:Array.from({length:16},(_,i)=>({x:1.123456789012345+i,y:2.123456789012345+i})),x:null,y:null,width:null,height:null,radius:null,fill:'none',stroke:'purple',strokeWidth:2.123456789012345};
 const large={shapes:Array.from({length:14},()=>clone(shape))};validateSpec(large);
 const f=await fixture(t,{provider:{async designIcons(keys){return{icons:keys.map(key=>({key,spec:large}))};}}});
 const records=[],budget=2*1024*1024;
 for(let i=0;i<500;i++){
  const next={key:'ext:cached'+i,status:'generated',attempts:0,retryAt:0,spec:large,error:null};
  if(Buffer.byteLength(JSON.stringify({version:1,records:[...records,next]}))>budget-600)break;
  records.push(next);
 }
 while(Buffer.byteLength(JSON.stringify({version:1,records}))<budget-1500){records.push({key:'ext:padding'+records.length,status:'generated',attempts:0,retryAt:0,spec:families.file,error:null});}
 assert.ok(records.length<511);
 records.push({key:'ext:budgetedge',status:'pending',attempts:0,retryAt:0,spec:null,error:null});
 await fs.mkdir(f.icons.stateDir,{recursive:true});await fs.writeFile(path.join(f.icons.stateDir,'file-icons.json'),JSON.stringify({version:1,records}));await f.icons.initialize();
 f.icons.resolve(['ext:budgetedge']);await f.icons.pump();
 assert.equal(f.icons.records.get('ext:budgetedge').status,'failed');assert.match(f.icons.records.get('ext:budgetedge').error,/cache budget/);
 assert.ok((await fs.stat(path.join(f.icons.stateDir,'file-icons.json'))).size<=budget);
 const resumed=new FileIcons({stateDir:f.icons.stateDir});t.after(()=>resumed.shutdown());await resumed.initialize();assert.equal(resumed.records.size,records.length);assert.equal(resumed.warning,null);assert.equal(resumed.records.get('ext:cached0').status,'generated');
});

test('renderer bypasses images/special entries and keeps exceptional identifiers local without poisoning ordinary generation',async()=>{
 const {fileTypeKey,TypeIcons}=await renderer(),batches=[];
 const icons=new TypeIcons({async resolve(keys){batches.push(keys);return keys.map(key=>({key,state:'pending'}));}});icons.paintNode=()=>{};icons.paint=()=>{};
 const untouched={};for(const type of ['image','folder','symlink','special']){assert.equal(fileTypeKey({type,name:'Photo.novel',extension:'novel'}),null);icons.decorate(untouched,{type,extension:'novel'});}assert.deepEqual(untouched,{});
 assert.equal(fileTypeKey({type:'file',name:'.hidden',extension:''}),'file:extensionless');assert.equal(fileTypeKey({type:'file',name:'Dockerfile',extension:''}),'name:dockerfile');assert.equal(fileTypeKey({type:'file',name:'backup.tar.gz',extension:'gz'}),'ext:tar.gz');
 const unusual=['thisextensionislongerthantwentyfour','图片','odd<svg>'];const unusualKeys=new Set();
 for(const extension of unusual){const node={dataset:{}};icons.decorate(node,{type:'file',name:'x.'+extension,extension});assert.match(node.dataset.fileTypeKey,/^fallback:/);assert.ok(node.dataset.typeBadge);unusualKeys.add(node.dataset.fileTypeKey);}
 assert.equal(unusualKeys.size,3);icons.decorate({dataset:{}},{type:'file',name:'fresh.novel',extension:'novel'});clearTimeout(icons.timer);icons.timer=null;await icons.flush();assert.deepEqual(batches,[['ext:novel']]);
});

test('late icon generation detaches decoration and never replaces a resolved inspector text/media preview',async()=>{
 const {TypeIcons}=await renderer();const icons=new TypeIcons({});
 for(const preview of ['text','image','audio','video','pdf']){
  const content={preview},node={dataset:{fileTypeKey:'ext:novel',iconState:'pending',typeLabel:'novel',typeBadge:'NOVEL'},classList:{contains:value=>value==='preview-frame'},querySelector:()=>content,removeAttribute:name=>assert.equal(name,'title'),replaceChildren(){assert.fail('Resolved preview must stay untouched');}};
  icons.paintNode(node,'ext:novel');assert.deepEqual(node.dataset,{});assert.equal(content.preview,preview);
 }
});
