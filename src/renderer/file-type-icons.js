// File-type decorations only: image entries never enter the generated-icon path.
const NS='http://www.w3.org/2000/svg';
const names=new Set(['makefile','dockerfile','license','readme','changelog','gitignore','editorconfig','npmrc','env']);
const compounds=['tar.gz','tar.bz2','tar.xz'];
const typeHash=value=>{let hash=2166136261;for(const letter of value)hash=Math.imul(hash^letter.codePointAt(0),16777619)>>>0;return hash.toString(16).padStart(8,'0');};
export function fileTypeKey(entry){
 if(['image','folder','symlink','special'].includes(entry.type))return null;
 const basename=(entry.name||'').toLowerCase();
 for(const compound of compounds)if(basename.endsWith('.'+compound))return'ext:'+compound;
 const recognized=basename.replace(/^\./,'');if(names.has(recognized))return'name:'+recognized;
 const extension=String(entry.extension||'').toLowerCase();
 if(!extension)return'file:extensionless';
 return /^[a-z0-9][a-z0-9_+-]{0,23}$/.test(extension)?'ext:'+extension:'fallback:'+typeHash(extension);
}
export function drawTypeIcon(spec,badge){
 const wrap=document.createElement('span');wrap.className='file-type-art';
 const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 48 48');svg.setAttribute('aria-hidden','true');svg.classList.add('type-glyph');
 for(const shape of spec.shapes){
  const primitive=document.createElementNS(NS,shape.kind);
  if(shape.points)primitive.setAttribute('points',shape.points.map(point=>`${point.x},${point.y}`).join(' '));
  if(shape.kind==='circle'){primitive.setAttribute('cx',shape.x);primitive.setAttribute('cy',shape.y);primitive.setAttribute('r',shape.radius);}
  else if(shape.kind==='rect'){for(const key of ['x','y','width','height'])primitive.setAttribute(key,shape[key]);primitive.setAttribute('rx',shape.radius);}
  primitive.setAttribute('fill',shape.fill==='none'?'none':shape.fill==='white'?'#fff':'var(--purple)');primitive.setAttribute('stroke',shape.stroke==='none'?'none':shape.stroke==='white'?'#fff':'var(--purple)');primitive.setAttribute('stroke-width',shape.strokeWidth);primitive.setAttribute('stroke-linejoin','round');primitive.setAttribute('stroke-linecap','round');svg.append(primitive);
 }
 const label=document.createElement('span');label.className='type-badge';label.textContent=badge;wrap.append(svg,label);return wrap;
}
export class TypeIcons{
 constructor(api){this.api=api;this.catalog={};this.families={};this.cache=new Map();this.requested=new Set();this.pending=new Set();this.timer=null;}
 async initialize(){const data=await this.api.boot();this.catalog=data.catalog;this.families=data.families;for(const record of data.records)this.cache.set(record.key,record);this.api.onUpdate(update=>{this.cache.set(update.key,update);this.paint(update.key);});}
 fallback(key){let hash=0;for(const letter of key)hash=((hash*31)+letter.charCodeAt(0))>>>0;const corner=4+hash%9;return{shapes:[{kind:'polygon',points:[{x:24,y:4},{x:42,y:corner+6},{x:38,y:39},{x:24,y:44},{x:10,y:39},{x:6,y:corner+6}],x:null,y:null,width:null,height:null,radius:null,fill:'none',stroke:'purple',strokeWidth:2.4},{kind:'circle',points:null,x:18+hash%13,y:22,width:null,height:null,radius:4,fill:'purple',stroke:'white',strokeWidth:1.5}]};}
 decorate(node,entry){const key=fileTypeKey(entry);if(!key)return;node.dataset.fileTypeKey=key;if(key.startsWith('fallback:')){node.dataset.typeBadge=[...String(entry.extension).toUpperCase()].slice(0,6).join('')+'·'+key.slice(-4);node.dataset.typeLabel=String(entry.extension).slice(0,80);}this.paintNode(node,key);if(key.startsWith('ext:')&&!this.catalog[key]&&!this.requested.has(key)){this.requested.add(key);this.pending.add(key);if(!this.timer)this.timer=setTimeout(()=>this.flush(),80);}}
 paintNode(node,key){
  // A real inspector preview takes ownership of this frame. Late background icon
  // responses must never replace decoded media or safe text already displayed.
  if(node.classList.contains('preview-frame')&&node.querySelector('img,video,audio,iframe,.preview-text')){delete node.dataset.fileTypeKey;delete node.dataset.iconState;delete node.dataset.typeBadge;delete node.dataset.typeLabel;node.removeAttribute('title');return;}
  const built=this.catalog[key],record=this.cache.get(key);const state=built?'builtin':key.startsWith('fallback:')?'fallback':record?.state||'pending';
  const spec=built?this.families[built.family]:record?.spec||this.fallback(key);const badge=built?.badge||node.dataset.typeBadge||key.slice(4).toUpperCase();
  node.replaceChildren(drawTypeIcon(spec,badge));node.dataset.iconState=state;node.title=`${node.dataset.typeLabel||key.replace(/^(ext|name):/,'')} · ${built?'Built-in type icon':key.startsWith('fallback:')?'Unusual type identifier · distinct local fallback; not shared with the model':record?.message||'Distinct fallback · VEYL icon queued'}`;
 }
 paint(key){for(const node of document.querySelectorAll('[data-file-type-key]'))if(node.dataset.fileTypeKey===key)this.paintNode(node,key);}
 async flush(){this.timer=null;const keys=[...this.pending].slice(0,128);keys.forEach(key=>this.pending.delete(key));try{for(const record of await this.api.resolve(keys)){this.cache.set(record.key,record);this.paint(record.key);}}catch{for(const key of keys){this.cache.set(key,{key,state:'failed',message:'Type icon service unavailable; fallback retained'});this.paint(key);}}if(this.pending.size)this.timer=setTimeout(()=>this.flush(),80);}
}
