'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {EventEmitter}=require('node:events');
const {FileClipboard,decode,encode,GNOME}=require('../src/file-clipboard.cjs');const {FolderWatch}=require('../src/folder-watch.cjs');const {FilesystemService}=require('../src/filesystem.cjs');
class Item{constructor(data){this.data=data;this.types=Object.keys(data);}async getType(type){return this.data[type];}}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'systemus-desktop-test-'));const home=path.join(root,'home');await fs.mkdir(path.join(home,'out'),{recursive:true});const filesystem=new FilesystemService({home,stateDir:path.join(root,'state'),trashRoot:path.join(root,'Trash')});let items=[];const clipboard={async read(){return items;},async write(value){items=value;},clear(){items=[];}};const service=new FileClipboard({clipboard,ClipboardItem:Item,filesystem});t.after(async()=>{filesystem.cancelAll();await fs.rm(root,{recursive:true,force:true});});return {home,filesystem,clipboard,service};}
test('local clipboard URI decoding preserves spaces/non-ASCII and rejects remote, malformed, newline, duplicate and arbitrary text',()=>{
 const paths=['/tmp/é space.txt','/tmp/a%file'];assert.deepEqual(decode(encode(paths,true),true),{action:'move',paths});
 for(const value of ['https://host/file','file://remote/tmp/x','file:///tmp/%ZZ','file:///tmp/a%0Ab','/tmp/plain','file:///tmp/a\nfile:///tmp/a','file:///tmp/a?query','file:///tmp/a%2Fb'])assert.throws(()=>decode(value),{code:'CLIPBOARD'});
});
test('owned OS cut identity refuses replacement; external URI paste uses guarded copy/undo',async t=>{
 const f=await fixture(t);const file=path.join(f.home,'é space.txt');await fs.writeFile(file,'original');await f.service.copy([file],true);await fs.unlink(file);await fs.writeFile(file,'replacement');
 await assert.rejects(f.service.paste(path.join(f.home,'out')),{code:'CHANGED'});assert.equal(await fs.readFile(file,'utf8'),'replacement');
 await f.clipboard.write([new Item({'text/uri-list':new Blob([encode([file]).split('\n').slice(1).join('\n')])})]);
 const result=await f.service.paste(path.join(f.home,'out'));assert.equal(result.errors.length,0);assert.equal(await fs.readFile(path.join(f.home,'out','é space.txt'),'utf8'),'replacement');assert.equal((await f.filesystem.mutate({action:'undo'})).errors.length,0);
});
test('clipboard refuses canonical duplicates and never overwrites paste collision',async t=>{
 const f=await fixture(t);const file=path.join(f.home,'a.txt');await fs.writeFile(file,'source');await assert.rejects(f.service.copy([file,file]),{code:'CLIPBOARD'});
 await f.service.copy([file]);await fs.writeFile(path.join(f.home,'out','a.txt'),'existing');const result=await f.service.paste(path.join(f.home,'out'));assert.equal(result.errors[0].code,'EXISTS');assert.equal(await fs.readFile(path.join(f.home,'out','a.txt'),'utf8'),'existing');
});
test('folder watchers debounce only visible roots, invalidate metadata variants and close replaced roots',async()=>{
 const watchers=[],events=[];const filesystem={directory:async file=>file,listCache:new Map([['/a\0false\0',{}],['/a\0true\0x',{}],['/b\0false\0',{}]])};
 const manager=new FolderWatch({filesystem,delay:10,emit:event=>events.push(event),watchImpl:(root,opts,callback)=>{const watcher=new EventEmitter();watcher.close=()=>{watcher.closed=true;};watchers.push({root,callback,watcher});return watcher;}});
 try{await manager.set(['/a','/b']);watchers[0].callback();watchers[0].callback();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(events.length,1);assert.deepEqual(events[0].paths,['/a']);assert.equal(filesystem.listCache.size,1);
 await manager.set(['/b']);assert.equal(watchers[0].watcher.closed,true);watchers[0].callback();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(events.length,1);
 }finally{manager.close();}assert.equal(watchers[1].watcher.closed,true);
});

test('successful cut reports actual changes even if clipboard clearing fails afterward',async t=>{
 const f=await fixture(t);const file=path.join(f.home,'cut.txt');await fs.writeFile(file,'exact');await f.service.copy([file],true);
 f.clipboard.clear=()=>{throw new Error('clipboard unavailable');};
 const result=await f.service.paste(path.join(f.home,'out'));assert.equal(result.errors.length,0);assert.equal(result.changes.length,1);assert.match(result.warning,/moved successfully/);assert.equal(await fs.readFile(path.join(f.home,'out','cut.txt'),'utf8'),'exact');await assert.rejects(fs.lstat(file),{code:'ENOENT'});
});
