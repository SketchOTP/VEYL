'use strict';
const {watch}=require('node:fs');
class FolderWatch {
 constructor({filesystem,emit,watchImpl=watch,delay=300}){this.fs=filesystem;this.emit=emit;this.watchImpl=watchImpl;this.delay=delay;this.roots=new Map();this.pending=new Set();this.timer=null;this.generation=0;}
 async set(paths){
  if(!Array.isArray(paths)||paths.length>2)throw new Error('Watch only the visible folders.');
  const generation=++this.generation;
  const roots=new Set(await Promise.all(paths.filter(p=>p!=='trash:').map(p=>this.fs.directory(p))));
  if(generation!==this.generation)return {paths:[...this.roots.keys()]};
  for(const [root,watcher] of this.roots)if(!roots.has(root)){watcher.close();this.roots.delete(root);this.pending.delete(root);}
  for(const root of roots)if(!this.roots.has(root)){
   try{const watcher=this.watchImpl(root,{persistent:false},()=>this.changed(root));watcher.on('error',()=>{watcher.close();this.roots.delete(root);this.emit({paths:[root],warning:'Folder notifications unavailable; refresh on focus or manually.'});});this.roots.set(root,watcher);}catch{this.emit({paths:[root],warning:'Folder notifications unavailable; refresh on focus or manually.'});}
  }
  return {paths:[...this.roots.keys()]};
 }
 changed(root){if(!this.roots.has(root))return;this.pending.add(root);clearTimeout(this.timer);this.timer=setTimeout(()=>{const paths=[...this.pending];this.pending.clear();for(const root of paths)for(const key of this.fs.listCache.keys())if(key.startsWith(root+'\0'))this.fs.listCache.delete(key);if(paths.length)this.emit({paths});},this.delay);}
 close(){this.generation++;clearTimeout(this.timer);for(const watcher of this.roots.values())watcher.close();this.roots.clear();this.pending.clear();}
}
module.exports={FolderWatch};
