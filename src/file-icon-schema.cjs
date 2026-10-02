'use strict';
const nullableNumber = { type: ['number','null'] };
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const point = object({x:{type:'number'},y:{type:'number'}});
const shape = object({kind:{type:'string',enum:['polyline','polygon','rect','circle']},points:{type:['array','null'],items:point},x:nullableNumber,y:nullableNumber,width:nullableNumber,height:nullableNumber,radius:nullableNumber,fill:{type:'string',enum:['none','purple','white']},stroke:{type:'string',enum:['none','purple','white']},strokeWidth:{type:'number'}});
const specSchema = object({shapes:{type:'array',items:shape}});
const iconSchema = object({icons:{type:'array',items:object({key:{type:'string'},spec:specSchema})}});
function fail(message){const error=new Error(`Invalid file icon: ${message}`);error.code='ICON_SCHEMA';throw error;}
function typeKey(key){if(typeof key!=='string'||!/^ext:[a-z0-9][a-z0-9_+-]{0,23}(?:\.[a-z0-9]{1,8})?$/.test(key))fail('unsupported normalized extension key');return key;}
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail('unexpected object fields');}
function number(value,min=0,max=48){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail('geometry is outside its bounds');}
function validateSpec(spec){
 exact(spec,['shapes']);if(!Array.isArray(spec.shapes)||spec.shapes.length<1||spec.shapes.length>14)fail('use 1–14 shapes');
 for(const shape of spec.shapes){
  exact(shape,['kind','points','x','y','width','height','radius','fill','stroke','strokeWidth']);
  if(!['polyline','polygon','rect','circle'].includes(shape.kind)||!['none','purple','white'].includes(shape.fill)||!['none','purple','white'].includes(shape.stroke)||shape.fill==='none'&&shape.stroke==='none')fail('unsupported shape or palette');number(shape.strokeWidth,1,4);
  if(['polygon','polyline'].includes(shape.kind)){
   if(!Array.isArray(shape.points)||shape.points.length<(shape.kind==='polygon'?3:2)||shape.points.length>16)fail('invalid points');
   for(const point of shape.points){exact(point,['x','y']);number(point.x);number(point.y);}
   if(['x','y','width','height','radius'].some(key=>shape[key]!==null)||shape.kind==='polyline'&&shape.fill!=='none')fail('unused geometry fields must be null');
  }else{
   if(shape.points!==null)fail('points must be null');number(shape.x);number(shape.y);number(shape.radius,0,24);
   if(shape.kind==='circle'){
    if(shape.width!==null||shape.height!==null||shape.radius<1||shape.x-shape.radius<0||shape.y-shape.radius<0||shape.x+shape.radius>48||shape.y+shape.radius>48)fail('invalid circle');
   }else{number(shape.width,1);number(shape.height,1);if(shape.x+shape.width>48||shape.y+shape.height>48||shape.radius>Math.min(shape.width,shape.height)/2)fail('invalid rounded rectangle');}
  }
 }
 return spec;
}
function validateIcons(result,keys){
 exact(result,['icons']);if(!Array.isArray(result.icons)||result.icons.length!==keys.length||keys.length<1||keys.length>6)fail('icon batch must match requested keys');const expected=new Set(keys.map(typeKey));if(expected.size!==keys.length)fail('duplicate requested keys');
 for(const item of result.icons){exact(item,['key','spec']);typeKey(item.key);if(!expected.delete(item.key))fail('unrequested or duplicate key');validateSpec(item.spec);}
 if(expected.size)fail('missing requested icon');return result;
}
module.exports={iconSchema,validateSpec,validateIcons,typeKey};
