// Trusted fixed decoder only. Neither file paths nor model output reach this page.
window.decodeSystemusRaster=async({base64,maxSide,maxPixels,format})=>{
 const data=Uint8Array.from(atob(base64),letter=>letter.charCodeAt(0));
 const mime={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',bmp:'image/bmp',ico:'image/x-icon'}[format];if(!mime)throw new Error('Unsupported raster format.');
 const bitmap=await createImageBitmap(new Blob([data],{type:mime}),{imageOrientation:'from-image'});
 try{
  if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>maxPixels||bitmap.width>12000||bitmap.height>12000)throw new Error('Decoded image dimensions exceed their budget.');
  const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
  const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
  const context=canvas.getContext('2d',{alpha:true});if(!context)throw new Error('Image decoder canvas unavailable.');context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const blob=await canvas.convertToBlob({type:'image/png'});if(blob.size>8*1024*1024)throw new Error('Sanitized PNG exceeds its budget.');
  const bytes=new Uint8Array(await blob.arrayBuffer());let result='';for(let offset=0;offset<bytes.length;offset+=32768)result+=String.fromCharCode(...bytes.subarray(offset,offset+32768));return btoa(result);
 }finally{bitmap.close();}
};
