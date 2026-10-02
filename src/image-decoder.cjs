'use strict';
// Separate trusted, hidden renderer: no preload, IPC capability, file URLs or network.
class ImageDecoder{
 constructor({BrowserWindow,timeout=10000}={}){this.BrowserWindow=BrowserWindow;this.timeout=timeout;this.window=null;this.loading=null;}
 async decode(bytes,{signal,maxSide=1280,maxPixels=32_000_000,format}={}){
  if(signal?.aborted)throw Object.assign(new Error('Image decoding cancelled.'),{code:'CANCELLED'});
  let timer,abort;
  const cancelled=new Promise((_resolve,reject)=>{abort=()=>{this.close();reject(Object.assign(new Error('Image decoding cancelled.'),{code:'CANCELLED'}));};signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{this.close();reject(Object.assign(new Error('Image decoding timed out; no images renamed.'),{code:'IMAGE_TIMEOUT'}));},this.timeout);});
  try{
   const operation=(async()=>{
    if(!this.window||this.window.isDestroyed()){
     this.window=new this.BrowserWindow({show:false,width:1,height:1,skipTaskbar:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,backgroundThrottling:false}});
     this.window.webContents.setWindowOpenHandler(()=>({action:'deny'}));this.window.webContents.on('will-navigate',event=>event.preventDefault());this.window.webContents.on('will-attach-webview',event=>event.preventDefault());
     this.loading=this.window.loadURL('systemus://app/image-decoder.html');
    }
    const current=this.window;await this.loading;
    if(signal?.aborted||current.isDestroyed())throw Object.assign(new Error('Image decoding cancelled.'),{code:'CANCELLED'});
    const result=await current.webContents.executeJavaScript(`window.decodeSystemusRaster(${JSON.stringify({base64:bytes.toString('base64'),maxSide,maxPixels,format})})`,false);
    return Buffer.from(result,'base64');
   })();return await Promise.race([operation,cancelled]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 close(){if(this.window&&!this.window.isDestroyed())this.window.destroy();this.window=null;this.loading=null;}
}
module.exports={ImageDecoder};
