#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const ID='io.github.SketchOTP.VEYL';
const LEGACY_ID='io.github.SketchOTP.SYSTEMUS';
function localPath(value,label){if(typeof value!=='string'||!path.isAbsolute(value)||/[\0\r\n]/.test(value))throw new Error(`${label} must be an absolute path without control characters.`);return path.resolve(value);}
function value(text){return text.replace(/\\/g,'\\\\').replace(/\t/g,'\\t');}
function quoteExec(text){
 if(/[\0\r\n]/.test(text))throw new Error('Desktop Exec paths cannot contain control characters.');
 // General desktop-string escaping precedes Exec quoting; literal backslashes therefore need four slashes.
 return '"'+text.replace(/%/g,'%%').replace(/[\\"`$]/g,char=>char==='\\'?'\\\\\\\\':'\\\\'+char)+'"';
}
function entryFields(text){
 const fields=new Map();let active=false;
 for(const line of text.split(/\r?\n/)){if(line.startsWith('[')){active=line==='[Desktop Entry]';continue;}if(!active||!line||line.startsWith('#'))continue;const split=line.indexOf('=');if(split<1)continue;const key=line.slice(0,split);if(fields.has(key))return null;fields.set(key,line.slice(split+1));}return fields;
}
function decodeValue(text){return text?.replace(/\\([sntr\\])/g,(_all,char)=>({s:' ',n:'\n',t:'\t',r:'\r','\\':'\\'}[char]??char));}
function ownsCheckoutEntry(text,root){const fields=entryFields(text);if(!fields||fields.get('X-SYSTEMUS-Managed')!=='true'||decodeValue(fields.get('Path'))!==root)return false;const node=decodeValue(fields.get('TryExec'));if(typeof node!=='string'||!path.isAbsolute(node)||/[\0\r\n]/.test(node))return false;return fields.get('Exec')===`${quoteExec(node)} ${quoteExec(path.join(root,'scripts/start'))}`;}
async function migrateLegacy({applications,desktop,root}){
 const removed=[],preserved=[];
 for(const folder of [applications,desktop]){const file=path.join(folder,`${LEGACY_ID}.desktop`);let before;try{before=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()||before.size>65536){preserved.push(file);continue;}
  const text=await fs.readFile(file,'utf8');if(!ownsCheckoutEntry(text,root)){preserved.push(file);continue;}
  const now=await fs.lstat(file);if(now.ino!==before.ino||now.dev!==before.dev||now.mtimeMs!==before.mtimeMs||now.size!==before.size||(await fs.readFile(file,'utf8'))!==text)throw new Error(`Legacy launcher changed; preserved: ${file}`);
  await fs.unlink(file);await fs.lstat(file).then(()=>{throw new Error(`Legacy launcher removal did not settle: ${file}`);},error=>{if(error.code!=='ENOENT')throw error;});removed.push(file);
 }
 return {removed,preserved};
}
async function desktopEntry({projectRoot,nodePath,iconPath}){
 const root=localPath(projectRoot,'Project root'),node=localPath(nodePath,'Node executable'),icon=localPath(iconPath,'Icon');
 if(node.includes('='))throw new Error('The desktop executable path cannot contain an equals sign.');
 const template=await fs.readFile(path.join(root,'assets',`${ID}.desktop.in`),'utf8');
 return template.replace('@EXEC@',`${quoteExec(node)} ${quoteExec(path.join(root,'scripts/start'))}`).replace('@NODE@',value(node)).replace('@ROOT@',value(root)).replace('@ICON@',value(icon));
}
async function directory(folder){await fs.mkdir(folder,{recursive:true,mode:0o755});const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o022))throw new Error(`Installation directory must be owned by this user and not writable by others: ${folder}`);}
async function writeAtomic(file,bytes,{mode=0o644,managed=false}={}){
 let before=null;try{before=await fs.lstat(file);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(before){if(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid())throw new Error(`Refusing to replace another user's file or a symlink: ${file}`);if(managed&&!(await fs.readFile(file,'utf8')).includes('\nX-SYSTEMUS-Managed=true\n'))throw new Error(`An unrelated desktop entry already exists: ${file}`);}
 const temp=path.join(path.dirname(file),`.systemus-install-${process.pid}-${require('node:crypto').randomUUID()}`);
 try{await fs.writeFile(temp,bytes,{flag:'wx',mode});
  const now=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if((before?.ino??null)!==(now?.ino??null)||(before?.mtimeMs??null)!==(now?.mtimeMs??null))throw new Error(`Destination changed during installation: ${file}`);
  await fs.rename(temp,file);if(!(await fs.readFile(file)).equals(Buffer.from(bytes)))throw new Error(`Installed file readback failed: ${file}`);
 }finally{await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function installDesktop({env=process.env,projectRoot=path.resolve(__dirname,'..'),nodePath=process.execPath,desktopDirectory=null,execImpl=execute}={}){
 const root=localPath(projectRoot,'Project root'),home=localPath(env.HOME||os.homedir(),'Home');
 const data=localPath(env.XDG_DATA_HOME||path.join(home,'.local','share'),'XDG data directory');
 const applications=path.join(data,'applications'),icons=path.join(data,'icons','hicolor','scalable','apps');
 if(desktopDirectory===null){const result=await execImpl('/usr/bin/xdg-user-dir',['DESKTOP'],{env,timeout:3000,maxBuffer:16384});desktopDirectory=result.stdout.trim();}
 const desktop=localPath(desktopDirectory,'XDG desktop directory');
 if(desktop===home)throw new Error('XDG desktop icons are disabled (DESKTOP equals HOME). Enable a dedicated desktop directory before installation.');
 await fs.access(nodePath,1);await fs.access(path.join(root,'scripts/start'));await fs.access(path.join(root,'assets/veyl.svg'));
 await directory(applications);await directory(icons);await directory(desktop);
 const entry=path.join(applications,`${ID}.desktop`),shortcut=path.join(desktop,`${ID}.desktop`),icon=path.join(icons,`${ID}.svg`);
 // Refuse unmanaged .desktop conflicts before changing any installed assets.
 for(const file of [entry,shortcut]){try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>65536||!ownsCheckoutEntry(await fs.readFile(file,'utf8'),root))throw new Error(`Unmanaged launcher or another checkout already exists: ${file}`);}catch(error){if(error.code!=='ENOENT')throw error;}}
 await writeAtomic(icon,await fs.readFile(path.join(root,'assets/veyl.svg')));
 const text=await desktopEntry({projectRoot:root,nodePath,iconPath:icon});
 await writeAtomic(entry,text,{managed:true});await writeAtomic(shortcut,text,{managed:true,mode:0o755});
 const migration=await migrateLegacy({applications,desktop,root});
 return {applicationsEntry:entry,desktopEntry:shortcut,icon,nodePath,launchScript:path.join(root,'scripts/start'),migration,notice:'GNOME may require right-click → Allow Launching on the desktop shortcut. Only marked launchers for this checkout were replaced; unused legacy icons and user state are preserved. No default file-manager association was changed.'};
}
if(require.main===module)installDesktop().then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write(`VEYL desktop installation failed: ${error.message}\n`);process.exitCode=1;});
module.exports={installDesktop,desktopEntry,quoteExec,ownsCheckoutEntry,migrateLegacy,ID,LEGACY_ID};
