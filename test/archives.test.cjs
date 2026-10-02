'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { FilesystemService } = require('../src/filesystem.cjs');
async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'systemus-archive-test-'));
 const home = path.join(root, 'home'); await fs.mkdir(home);
 const service = new FilesystemService({home,stateDir:path.join(root,'state'),trashRoot:path.join(root,'Trash')});
 t.after(async()=>{service.cancelAll();await fs.rm(root,{recursive:true,force:true});});
 return {home,service};
}
async function malicious(file, entries, tar = false) {
 // Fixed test fixture generator; no model input or shell execution.
 const script = 'import sys,json,zipfile,tarfile,io\nf=sys.argv[1]; entries=json.loads(sys.argv[2]); tar=sys.argv[3]=="true"\nif tar:\n with tarfile.open(f,"w") as a:\n  for x in entries:\n   e=tarfile.TarInfo(x[0]); e.size=len(x[1]); e.type=tarfile.SYMTYPE if len(x)>2 else tarfile.REGTYPE; e.linkname="/etc/passwd" if len(x)>2 else ""; a.addfile(e,io.BytesIO(x[1].encode()))\nelse:\n with zipfile.ZipFile(f,"w") as a:\n  for x in entries: a.writestr(x[0],x[1])';
 await exec('/usr/bin/python3',['-I','-S','-B','-c',script,file,JSON.stringify(entries),String(tar)],{timeout:5000});
}
for (const format of ['zip','tar','tar.gz']) test(`archive ${format} round trip preserves exact bytes and guarded undo`,{timeout:15000},async t=>{
 const {home,service}=await fixture(t);const source=path.join(home,'photos');await fs.mkdir(source);const bytes=Buffer.alloc(1024*1024+7,0x47);await fs.writeFile(path.join(source,'é space.bin'),bytes);
 const created=await service.mutate({action:'archive-create',paths:[source],destination:home,name:`bundle.${format}`,format});assert.equal(created.errors.length,0);
 const extracted=await service.mutate({action:'archive-extract',paths:[path.join(home,`bundle.${format}`)],destination:home,name:'unpacked'});assert.equal(extracted.errors.length,0);
 assert.deepEqual(await fs.readFile(path.join(home,'unpacked','photos','é space.bin')),bytes);assert.deepEqual(await fs.readFile(path.join(source,'é space.bin')),bytes);
 assert.equal((await service.mutate({action:'undo'})).errors.length,0);await assert.rejects(fs.lstat(path.join(home,'unpacked')),{code:'ENOENT'});
 assert.equal((await service.mutate({action:'undo'})).errors.length,0);await assert.rejects(fs.lstat(path.join(home,`bundle.${format}`)),{code:'ENOENT'});
});
test('archives refuse traversal, absolute, duplicate, file-parent conflict and TAR links before destination creation',{timeout:15000},async t=>{
 const {home,service}=await fixture(t);
 const cases=[[['../escape','x']],[['/absolute','x']],[['same','a'],['same','b']],[['parent','a'],['parent/file','b']],[['link','',true]]];
 for(let i=0;i<cases.length;i++){const file=path.join(home,`bad${i}.archive`);await malicious(file,cases[i],i===4);const r=await service.mutate({action:'archive-extract',paths:[file],destination:home,name:`out${i}`});assert.equal(r.errors.length,1);await assert.rejects(fs.lstat(path.join(home,`out${i}`)),{code:'ENOENT'});}
});
test('implicit directories count toward preflight bounds, and existing destinations are never merged',{timeout:10000},async t=>{
 const {home,service}=await fixture(t);const file=path.join(home,'deep.zip');await malicious(file,[['a/b/c/d.txt','ok']]);service.archives.limits.entries=3;
 const r=await service.mutate({action:'archive-extract',paths:[file],destination:home,name:'out'});assert.equal(r.errors.length,1);await assert.rejects(fs.lstat(path.join(home,'out')),{code:'ENOENT'});
 await fs.mkdir(path.join(home,'out'));await fs.writeFile(path.join(home,'out','keep'),'untouched');await assert.rejects(service.mutate({action:'archive-extract',paths:[file],destination:home,name:'out'}),{code:'EXISTS'});assert.equal(await fs.readFile(path.join(home,'out','keep'),'utf8'),'untouched');
});
test('archive creation rejects links, detects changed source before helper writes, and undo preserves later edits',{timeout:10000},async t=>{
 const {home,service}=await fixture(t);const file=path.join(home,'note.txt');await fs.writeFile(file,'original');const link=path.join(home,'link');await fs.symlink(file,link);
 await assert.rejects(service.mutate({action:'archive-create',paths:[link],destination:home,name:'link.zip'}));
 const invoke=service.archives.invoke.bind(service.archives);service.archives.invoke=async payload=>{await fs.writeFile(file,'changed');return invoke(payload);};
 const changed=await service.mutate({action:'archive-create',paths:[file],destination:home,name:'changed.zip'});assert.equal(changed.errors.length,1);await assert.rejects(fs.lstat(path.join(home,'changed.zip')),{code:'ENOENT'});
 service.archives.invoke=invoke;assert.equal((await service.mutate({action:'archive-create',paths:[file],destination:home,name:'good.zip'})).errors.length,0);await fs.appendFile(path.join(home,'good.zip'),'later');assert.equal((await service.mutate({action:'undo'})).errors.length,1);assert.ok((await fs.stat(path.join(home,'good.zip'))).size>0);
});

test('archive byte/encryption limits refuse output; extraction undo preserves later additions',{timeout:12000},async t=>{
 const {home,service}=await fixture(t);const file=path.join(home,'data.zip');await malicious(file,[['file.txt','payload']]);
 service.archives.limits.bytes=2;let r=await service.mutate({action:'archive-extract',paths:[file],destination:home,name:'too-large'});assert.equal(r.errors.length,1);await assert.rejects(fs.lstat(path.join(home,'too-large')),{code:'ENOENT'});service.archives.limits.bytes=1024;
 const bytes=await fs.readFile(file);bytes.writeUInt16LE(bytes.readUInt16LE(6)|1,6);const central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt16LE(bytes.readUInt16LE(central+8)|1,central+8);await fs.writeFile(path.join(home,'encrypted.zip'),bytes);
 r=await service.mutate({action:'archive-extract',paths:[path.join(home,'encrypted.zip')],destination:home,name:'encrypted'});assert.equal(r.errors.length,1);await assert.rejects(fs.lstat(path.join(home,'encrypted')),{code:'ENOENT'});
 assert.equal((await service.mutate({action:'archive-extract',paths:[file],destination:home,name:'accepted'})).errors.length,0);await fs.writeFile(path.join(home,'accepted','later.txt'),'later edit');const undone=await service.mutate({action:'undo'});assert.equal(undone.errors.length,1);assert.equal(await fs.readFile(path.join(home,'accepted','later.txt'),'utf8'),'later edit');assert.equal(await fs.readFile(path.join(home,'accepted','file.txt'),'utf8'),'payload');
});
