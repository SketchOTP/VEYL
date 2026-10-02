'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {identity}=require('./filesystem.cjs');

const LIMITS={images:64,batch:6,fileBytes:20*1024*1024,totalBytes:128*1024*1024,pixels:32_000_000,side:12000,outputSide:1280,outputBytes:8*1024*1024};
function fail(message,code='IMAGE_INPUT'){throw Object.assign(new Error(message),{code});}
function checkAbort(signal){if(signal?.aborted)fail('Image request cancelled; no changes applied.','CANCELLED');}
function dimensions(width,height,format){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>LIMITS.side||height>LIMITS.side||width*height>LIMITS.pixels)fail('Image dimensions exceed 12,000 pixels per side or 32 megapixels.','IMAGE_LIMIT');
 return{width,height,format};
}
// Read dimensions before allocating a decoded bitmap. This supplements the
// isolated Chromium decoder, which still validates the complete encoded image.
function imageHeader(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<10)fail('Image is empty or has no supported raster header.');
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
  if(bytes.length<33||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')fail('Invalid PNG header.');
  return dimensions(bytes.readUInt32BE(16),bytes.readUInt32BE(20),'png');
 }
 if(bytes[0]===255&&bytes[1]===216){
  let offset=2;
  while(offset+3<bytes.length){
   if(bytes[offset++]!==255)fail('Invalid JPEG markers.');while(bytes[offset]===255)offset++;
   const marker=bytes[offset++];if(marker===0xd9||marker===0xda)break;
   if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
   if(offset+2>bytes.length)break;const length=bytes.readUInt16BE(offset);
   if(length<2||offset+length>bytes.length)fail('Invalid JPEG segment.');
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
    if(length<8)fail('Invalid JPEG frame.');return dimensions(bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3),'jpeg');
   }
   offset+=length;
  }fail('JPEG frame dimensions are missing.');
 }
 const magic=bytes.toString('ascii',0,6);
 if(magic==='GIF87a'||magic==='GIF89a')return dimensions(bytes.readUInt16LE(6),bytes.readUInt16LE(8),'gif');
 if(bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
  const end=bytes.readUInt32LE(4)+8;if(end>bytes.length)fail('Truncated WebP container.');
  for(let offset=12;offset+8<=end;){
   const tag=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;if(start+size>end)fail('Invalid WebP chunk.');
   if(tag==='VP8X'&&size>=10)return dimensions(bytes.readUIntLE(start+4,3)+1,bytes.readUIntLE(start+7,3)+1,'webp');
   if(tag==='VP8 '&&size>=10&&bytes.subarray(start+3,start+6).equals(Buffer.from([157,1,42])))return dimensions(bytes.readUInt16LE(start+6)&0x3fff,bytes.readUInt16LE(start+8)&0x3fff,'webp');
   if(tag==='VP8L'&&size>=5&&bytes[start]===47){const bits=bytes.readUInt32LE(start+1);return dimensions((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1,'webp');}
   offset=start+size+(size&1);
  }fail('WebP dimensions are missing.');
 }
 if(bytes.length>=26&&bytes.toString('ascii',0,2)==='BM'){
  const dib=bytes.readUInt32LE(14);if(dib===12)return dimensions(bytes.readUInt16LE(18),bytes.readUInt16LE(20),'bmp');
  if(dib>=40)return dimensions(bytes.readInt32LE(18),Math.abs(bytes.readInt32LE(22)),'bmp');fail('Unsupported BMP header.');
 }
 if(bytes.length>=22&&bytes.readUInt16LE(0)===0&&bytes.readUInt16LE(2)===1){
  const count=bytes.readUInt16LE(4);if(!count||count>256||6+count*16>bytes.length)fail('Invalid ICO directory.');
  let width=0,height=0;for(let i=0;i<count;i++){
   const at=6+i*16,w=bytes[at]||256,h=bytes[at+1]||256;const size=bytes.readUInt32LE(at+8),start=bytes.readUInt32LE(at+12);if(size<16||start<6+count*16||start+size>bytes.length)fail('Invalid ICO image range.');
   const embedded=bytes.subarray(start,start+size);let value;
   if(embedded.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))value=imageHeader(embedded);
   else{const dib=embedded.readUInt32LE(0);if(dib>=40&&dib<=embedded.length)value=dimensions(embedded.readInt32LE(4),Math.abs(embedded.readInt32LE(8))/2,'ico');else if(dib===12)value=dimensions(embedded.readUInt16LE(4),embedded.readUInt16LE(6)/2,'ico');else fail('ICO embedded encoding cannot be bounded.');}
   if(value.width!==w||value.height!==h)fail('ICO directory dimensions disagree with its embedded bitmap.');width=Math.max(width,w);height=Math.max(height,h);
  }
  return dimensions(width,height,'ico');
 }
 if(bytes.length>=24&&bytes.toString('ascii',4,8)==='ftyp'){
  const brands=bytes.subarray(8,Math.min(bytes.readUInt32BE(0),bytes.length)).toString('ascii');
  if(!/avif|avis/.test(brands))fail('Unsupported image container.');let found=null,boxes=0;
  const parse=(start,end,depth)=>{
   if(depth>8)fail('AVIF metadata nesting exceeds its bound.');
   for(let offset=start;offset+8<=end;){
    if(++boxes>4096)fail('AVIF metadata exceeds its bound.');let size=bytes.readUInt32BE(offset),header=8;const type=bytes.toString('ascii',offset+4,offset+8);
    if(size===1){if(offset+16>end)fail('Truncated AVIF box.');const big=bytes.readBigUInt64BE(offset+8);if(big>BigInt(bytes.length))fail('Invalid AVIF box size.');size=Number(big);header=16;}else if(size===0)size=end-offset;
    if(size<header||offset+size>end)fail('Invalid AVIF box.');const content=offset+header;
    if(type==='ispe'){if(content+12>offset+size)fail('Invalid AVIF dimensions.');const value=dimensions(bytes.readUInt32BE(content+4),bytes.readUInt32BE(content+8),'avif');if(!found||value.width*value.height>found.width*found.height)found=value;}
    if(['meta','iprp','ipco'].includes(type))parse(content+(type==='meta'?4:0),offset+size,depth+1);
    offset+=size;
   }
  };parse(0,bytes.length,0);if(found)return found;fail('AVIF dimensions are missing.');
 }
 fail('Vision supports PNG, JPEG, WebP, GIF, AVIF, BMP and ICO rasters. SVG/TIFF/HEIC and other formats are unsupported.','IMAGE_FORMAT');
}

class ImageInputs{
 constructor({decode,closeDecoder=()=>{},scratchParent=os.tmpdir(),limits={}}={}){this.decode=decode;this.closeDecoder=closeDecoder;this.scratchParent=scratchParent;this.limits={...LIMITS,...limits};this.directory=null;this.entries=[];}
 async stage(entries,{signal}={}){
  if(!this.decode)fail('The sandboxed image decoder is unavailable. Restart SYSTEMUS.');
  if(!entries.length)fail('No regular image files matched this request.','IMAGE_EMPTY');
  if(entries.length>this.limits.images)fail(`Image vision is limited to ${this.limits.images} files per request; select a smaller set. No subset was processed.`,'IMAGE_LIMIT');
  this.directory=await fs.mkdtemp(path.join(this.scratchParent,'systemus-images-'));await fs.chmod(this.directory,0o700);
  let total=0;
  try{
   for(const entry of entries){
    if(!['png','jpg','jpeg','jpe','webp','gif','avif','bmp','ico'].includes(path.extname(entry.path).slice(1).toLowerCase()))fail('Vision supports PNG, JPEG, WebP, GIF, AVIF, BMP and ICO; SVG/TIFF/HEIC are unsupported. No subset was processed.','IMAGE_FORMAT');
    checkAbort(signal);const handle=await fs.open(entry.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let bytes;
    try{
     const stat=await handle.stat();if(!stat.isFile()||identity(stat)!==entry.identity)fail('Image changed before it could be read.','PLAN_STALE');
     if(stat.size>this.limits.fileBytes||total+stat.size>this.limits.totalBytes)fail('Image input exceeds 20 MiB per file or 128 MiB per request; no subset was processed.','IMAGE_LIMIT');
     bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length){checkAbort(signal);const read=await handle.read(bytes,offset,Math.min(1024*1024,bytes.length-offset),offset);if(!read.bytesRead)fail('Image changed while being read.','PLAN_STALE');offset+=read.bytesRead;}
     if(identity(await handle.stat())!==entry.identity||identity(await fs.lstat(entry.path))!==entry.identity)fail('Image changed while being read.','PLAN_STALE');total+=bytes.length;
    }finally{await handle.close();}
    const header=imageHeader(bytes),png=await this.decode(bytes,{signal,maxSide:this.limits.outputSide,maxPixels:this.limits.pixels,format:header.format});checkAbort(signal);
    if(!Buffer.isBuffer(png)||png.length>this.limits.outputBytes)fail('Decoded image exceeds its attachment budget.','IMAGE_LIMIT');
    const sanitized=imageHeader(png);if(sanitized.format!=='png'||sanitized.width>this.limits.outputSide||sanitized.height>this.limits.outputSide)fail('Image decoder returned an invalid sanitized attachment.');
    if(identity(await fs.lstat(entry.path))!==entry.identity)fail('Image changed during decoding.','PLAN_STALE');
    const staged=path.join(this.directory,`image-${String(this.entries.length+1).padStart(3,'0')}.png`);await fs.writeFile(staged,png,{flag:'wx',mode:0o600});
    this.entries.push({...entry,staged,format:header.format,width:header.width,height:header.height});
   }
   return this.entries;
  }catch(error){await this.close();throw error;}
 }
 async batch(offset,{signal}={}){
  checkAbort(signal);const entries=this.entries.slice(offset,offset+this.limits.batch);
  return{mapping:entries.map((entry,index)=>({attachment:index+1,path:entry.path,identity:entry.identity,format:entry.format,width:entry.width,height:entry.height})),images:await Promise.all(entries.map(async entry=>({bytes:await fs.readFile(entry.staged)})))};
 }
 async close(){this.closeDecoder();if(this.directory){await fs.rm(this.directory,{recursive:true,force:true});this.directory=null;}this.entries=[];}
}
module.exports={ImageInputs,imageHeader,LIMITS};
