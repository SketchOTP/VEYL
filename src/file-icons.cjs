'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');
const {CodexProvider}=require('./codex-provider.cjs');const {catalog,families}=require('./file-type-catalog.cjs');const {typeKey,validateSpec,validateIcons}=require('./file-icon-schema.cjs');
class FileIcons{
 constructor({stateDir,provider=new CodexProvider(),emit=()=>{},isBusy=()=>false,canGenerate=()=>true,debounce=300,maxRecords=512,maxNew=32,now=Date.now}={}){
  this.canGenerate=canGenerate;
  this.stateDir=stateDir;this.provider=provider;this.emit=emit;this.isBusy=isBusy;this.debounce=debounce;this.maxRecords=maxRecords;this.maxNew=maxNew;this.now=now;this.records=new Map();this.queue=new Set();this.newCount=0;this.closed=false;this.timer=null;this.active=null;this.saves=Promise.resolve();this.warning=null;
 }
 async initialize(){
  try{
   const file=path.join(this.stateDir,'file-icons.json'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error('Unsafe or oversized icon registry');
   const data=JSON.parse(await fs.readFile(file,'utf8'));if(data.version!==1||!Array.isArray(data.records)||data.records.length>this.maxRecords)throw new Error('Invalid icon registry');
   for(const record of data.records){
    typeKey(record.key);if(catalog[record.key]||this.records.has(record.key)||!Number.isInteger(record.attempts)||record.attempts<0||record.attempts>2||!['generated','failed','pending'].includes(record.status)||!Number.isFinite(record.retryAt))throw new Error('Invalid icon record');
    if(record.status==='generated')validateSpec(record.spec);
    this.records.set(record.key,{key:record.key,status:record.status,attempts:record.attempts,retryAt:record.retryAt,spec:record.status==='generated'?record.spec:null,error:typeof record.error==='string'?record.error.slice(0,240):null,persisted:true});
   }
  }catch(error){if(error.code!=='ENOENT'){this.records.clear();this.warning='Saved type icons could not be loaded; safe fallback icons are shown.';}}
  return this.boot();
 }
 boot(){return{catalog,families,records:[...this.records.values()].map(record=>this.public(record)),warning:this.warning};}
 stored(record){const {persisted,...value}=record;return value;}
 public(record){return{key:record.key,state:record.status,spec:record.status==='generated'?record.spec:null,persisted:Boolean(record.persisted),cacheWarning:this.warning,message:(record.error|| (record.status==='generated'?`Created by VEYL · ${record.persisted?'cached locally':'session icon; cache not yet saved'}`:'VEYL type icon pending'))+(this.warning?` · ${this.warning}`:'')};}
 resolve(keys){
  if(!Array.isArray(keys)||keys.length>128)throw new Error('Resolve at most128 normalized file types');
  const result=[];let changed=false;
  for(const key of new Set(keys)){
   if(Object.hasOwn(catalog,key)){result.push({key,state:'builtin',...catalog[key]});continue;}
   typeKey(key);let record=this.records.get(key);
   if(!this.canGenerate()&&record?.status!=='generated'){result.push({key,state:'disabled',message:'VEYL icon design permission is disabled; distinct fallback retained'});continue;}
   if(!record){
    if(this.records.size>=this.maxRecords||this.newCount>=this.maxNew||this.closed){result.push({key,state:'limited',message:'Automatic icon limit reached; distinct fallback retained'});continue;}
    record={key,status:'pending',attempts:0,retryAt:0,spec:null,error:null};this.records.set(key,record);this.newCount++;changed=true;
   }
   if(!this.closed&&record.status!=='generated'&&record.attempts<2&&record.retryAt<=this.now()&&!this.active?.keys.includes(key)){
    if(record.status!=='pending'){changed=true;record.status='pending';record.error=null;record.persisted=false;}this.queue.add(key);
   }
   result.push(this.public(record));
  }
  if(changed)this.save();this.schedule();return result;
 }
 save(){
  if(!this.stateDir)return Promise.resolve();
  this.saves=this.saves.then(async()=>{
   const records=[...this.records.values()].map(record=>this.stored(record)),payload=JSON.stringify({version:1,records});const file=path.join(this.stateDir,'file-icons.json'),tmp=path.join(this.stateDir,`icons-${randomUUID()}.tmp`);
   try{if(Buffer.byteLength(payload)>2*1024*1024)throw new Error('Icon cache exceeds budget');await fs.mkdir(this.stateDir,{recursive:true,mode:0o700});await fs.writeFile(tmp,payload,{flag:'wx',mode:0o600});await fs.rename(tmp,file);if(await fs.readFile(file,'utf8')!==payload)throw new Error('Icon registry readback differs');this.warning=null;for(const snapshot of records){const current=this.records.get(snapshot.key);if(current&&JSON.stringify(this.stored(current))===JSON.stringify(snapshot))current.persisted=true;}}
   catch{await fs.unlink(tmp).catch(()=>{});this.warning='Type icons remain available this session, but their local cache could not be saved.';}
  });return this.saves;
 }
 schedule(){if(this.closed||this.timer||this.active||!this.queue.size||!this.canGenerate())return;this.timer=setTimeout(()=>{this.timer=null;this.pump().catch(()=>{});},this.debounce);}
 async pump(){
  if(this.closed||this.active||!this.queue.size||!this.canGenerate())return;
  if(this.isBusy()){this.schedule();return;}
  const keys=[...this.queue].slice(0,6);keys.forEach(key=>this.queue.delete(key));const controller=new AbortController();
  const active={controller,keys,promise:null};this.active=active;
  active.promise=(async()=>{
   try{
    const result=validateIcons(await this.provider.designIcons(keys,{signal:controller.signal}),keys);
    if(controller.signal.aborted)throw Object.assign(new Error('Icon design paused'),{code:'CANCELLED'});
    for(const icon of result.icons){const record=this.records.get(icon.key);record.status='generated';record.spec=icon.spec;record.error=null;record.retryAt=0;record.persisted=false;
     if(Buffer.byteLength(JSON.stringify({version:1,records:[...this.records.values()].map(value=>this.stored(value))}))>2*1024*1024){record.status='failed';record.spec=null;record.attempts=2;record.error='Local icon cache budget reached; distinct fallback retained';}
    }
   }catch(error){
    for(const key of keys){const record=this.records.get(key);record.persisted=false;
     if(controller.signal.aborted||error.code==='CANCELLED'){record.status='pending';record.error='Icon design paused; will resume while VEYL is idle';if(!this.closed)this.queue.add(key);}
     else{record.status='failed';record.attempts++;record.retryAt=this.now()+24*60*60*1000;record.error=`Icon generation failed (${String(error.code||'PROVIDER').slice(0,32)}); fallback retained${record.attempts<2?'. Retry after24h when encountered again':'. Retry limit reached'}`;}
    }
   }finally{await this.save();for(const key of keys)this.emit(this.public(this.records.get(key)));if(this.active===active)this.active=null;this.schedule();}
  })();await active.promise;
 }
 async pause(){clearTimeout(this.timer);this.timer=null;const active=this.active;if(active){active.controller.abort();await active.promise;}this.schedule();}
 async shutdown(){this.closed=true;clearTimeout(this.timer);this.timer=null;this.queue.clear();if(this.active){this.active.controller.abort();await this.active.promise;}await this.saves;}
}
module.exports={FileIcons};
