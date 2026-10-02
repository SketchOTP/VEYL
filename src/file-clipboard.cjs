'use strict';
const fs = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { identity } = require('./filesystem.cjs');
const GNOME = 'electron application/osclipboard;format="x-special/gnome-copied-files"';
const URI = 'text/uri-list';
const RAW_URI = 'electron application/osclipboard;format="text/uri-list"';
function fail(message) { throw Object.assign(new Error(message),{code:'CLIPBOARD'}); }
function decode(text, gnome=false) {
 if (typeof text !== 'string' || Buffer.byteLength(text)>256*1024 || text.includes('\0')) fail('File clipboard is too large or malformed.');
 const lines=text.split(/\r?\n/);let action='copy';
 if(gnome){const operation=lines.shift();if(!['copy','cut'].includes(operation))fail('Unsupported GNOME file clipboard operation.');action=operation==='cut'?'move':'copy';}
 const paths=[];
 for(const line of lines){if(!line||line.startsWith('#'))continue;let url;try{url=new URL(line);}catch{fail('Malformed file URI in clipboard.');}
 if(url.protocol!=='file:'||url.host&&url.host!=='localhost'||url.search||url.hash||/%00|%2f|%5c/i.test(url.pathname))fail('Only local file URLs are supported.');
 let file;try{file=fileURLToPath(url);}catch{fail('Malformed file URI in clipboard.');}
 if(/[\0\r\n]/.test(file))fail('Clipboard filenames containing newlines are unsupported.');paths.push(file);
 }
 if(!paths.length||paths.length>500||new Set(paths).size!==paths.length)fail('Choose 1–500 distinct local files.');
 return {action,paths};
}
function encode(paths,cut=false){return `${cut?'cut':'copy'}\n${paths.map(file=>pathToFileURL(file).href).join('\n')}`;}
function hash(value){return createHash('sha256').update(value).digest('hex');}
class FileClipboard {
 constructor({clipboard,ClipboardItem,filesystem}){this.clipboard=clipboard;this.Item=ClipboardItem;this.fs=filesystem;this.owned=null;}
 async read(){
  const items=await this.clipboard.read();
  for(const item of items){for(const type of [GNOME,URI,RAW_URI]){if(!item.types.includes(type))continue;const blob=await item.getType(type);if(blob.size>256*1024)fail('File clipboard exceeds the safe bound.');const text=await blob.text();const value=decode(text,type===GNOME);const fingerprint=hash(type+'\0'+text);return {...value,fingerprint,owned:this.owned?.fingerprint===fingerprint};}}
  return null;
 }
 async copy(paths,cut=false){
  if(!Array.isArray(paths)||!paths.length||paths.length>500)fail('Choose 1–500 files.');
  const signatures={},checked=[];
  for(const file of paths){const source=await this.fs.canonical(file);this.fs.protect(source);const stat=await fs.lstat(source);if(!stat.isFile()&&!stat.isDirectory()&&!stat.isSymbolicLink())fail('Special files cannot be copied.');checked.push(source);signatures[source]=identity(stat);}
  if(new Set(checked).size!==checked.length)fail('Select distinct files.');
  const text=encode(checked,cut),uris=checked.map(file=>pathToFileURL(file).href).join('\r\n')+'\r\n';
  decode(text,true);
  if(Buffer.byteLength(text)>256*1024||Buffer.byteLength(uris)>256*1024)fail('File selection exceeds the clipboard bound.');
  await this.clipboard.write([new this.Item({[GNOME]:new Blob([text]),[URI]:new Blob([uris],{type:URI}),[RAW_URI]:new Blob([uris])})]);
  this.owned={fingerprint:hash(GNOME+'\0'+text),signatures};return {action:cut?'move':'copy',paths:checked};
 }
 async paste(destination,emit){
  const current=await this.read();if(!current)fail('The clipboard contains no supported local file selection.');
  const expected={};for(const source of current.paths){const file=await this.fs.canonical(source);if(file!==source)fail('Clipboard parent location changed. Copy the selection again.');expected[source]=current.owned?this.owned.signatures[source]:identity(await fs.lstat(source));if(!expected[source])fail('Clipboard source identity is unavailable.');}
  const result=await this.fs.mutate({action:current.action,paths:current.paths,destination,expectedIdentities:expected},emit);
  if(current.action==='move'&&!result.errors.length){try{const now=await this.read();if(now?.fingerprint===current.fingerprint){await this.clipboard.clear();this.owned=null;}}catch{result.warning='Files moved successfully, but the system clipboard could not be cleared. Copy a fresh selection before pasting again.';}}
  return result;
 }
}
module.exports={FileClipboard,decode,encode,GNOME,URI,RAW_URI};
