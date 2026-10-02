'use strict';
const {validateSpec}=require('./file-icon-schema.cjs');
const base={points:null,x:null,y:null,width:null,height:null,radius:null,fill:'none',stroke:'purple',strokeWidth:2.4};
const line=points=>({...base,kind:'polyline',points:points.map(([x,y])=>({x,y}))});
const rect=(x,y,width,height,radius=3)=>({...base,kind:'rect',x,y,width,height,radius});
const circle=(x,y,radius)=>({...base,kind:'circle',x,y,radius});
const families={
 text:{shapes:[rect(9,4,30,37),line([[15,13],[33,13]]),line([[15,20],[33,20]]),line([[15,27],[25,27]])]},
 markdown:{shapes:[rect(4,9,40,29),line([[10,29],[10,17],[17,24],[24,17],[24,29]]),line([[35,17],[35,29],[30,24]]),line([[35,29],[40,24]])]},
 document:{shapes:[rect(9,4,30,38),rect(15,11,18,9,1),line([[15,27],[33,27]]),line([[15,33],[26,33]])]},
 presentation:{shapes:[rect(4,7,40,29),line([[10,14],[22,14]]),line([[10,21],[18,21]]),line([[28,28],[28,22],[33,22],[33,16],[38,16]]),line([[24,36],[24,43]]),line([[16,43],[32,43]])]},
 data:{shapes:[rect(5,8,38,30),line([[5,18],[43,18]]),line([[5,28],[43,28]]),line([[18,8],[18,38]]),line([[30,8],[30,38]])]},
 code:{shapes:[line([[17,12],[5,24],[17,36]]),line([[31,12],[43,24],[31,36]]),line([[27,7],[21,41]])]},
 terminal:{shapes:[rect(4,7,40,33),line([[11,16],[20,23],[11,30]]),line([[24,31],[35,31]])]},
 config:{shapes:[line([[6,12],[42,12]]),line([[6,24],[42,24]]),line([[6,36],[42,36]]),circle(17,12,4),circle(31,24,4),circle(21,36,4)]},
 archive:{shapes:[rect(9,4,30,38),line([[21,4],[21,24]]),line([[26,8],[21,8],[21,13],[26,13],[26,18],[21,18]]),rect(18,26,9,10,2)]},
 audio:{shapes:[line([[18,33],[18,9],[37,5],[37,29]]),line([[18,17],[37,13]]),circle(12,33,6),circle(31,29,6)]},
 video:{shapes:[rect(4,10,29,29),line([[33,19],[44,12],[44,37],[33,30]]),line([[8,4],[27,4]])]},
 app:{shapes:[rect(10,10,28,28,6),rect(17,17,14,14,3),line([[17,3],[17,10]]),line([[31,3],[31,10]]),line([[17,38],[17,45]]),line([[31,38],[31,45]]),line([[3,17],[10,17]]),line([[38,31],[45,31]])]},
 font:{shapes:[line([[8,39],[23,7],[27,7],[41,39]]),line([[14,27],[35,27]]),line([[6,39],[15,39]]),line([[34,39],[43,39]])]},
 design:{shapes:[line([[24,4],[44,15],[24,27],[4,15],[24,4]]),line([[4,24],[24,36],[44,24]]),line([[4,33],[24,45],[44,33]])]},
 database:{shapes:[rect(7,5,34,38,8),line([[7,17],[15,22],[33,22],[41,17]]),line([[7,29],[15,34],[33,34],[41,29]])]},
 book:{shapes:[rect(8,5,33,38),line([[16,5],[16,43]]),line([[22,14],[34,14]]),line([[22,21],[34,21]])]},
 package:{shapes:[line([[24,4],[43,14],[43,35],[24,45],[5,35],[5,14],[24,4]]),line([[5,14],[24,25],[43,14]]),line([[24,25],[24,45]]),line([[14,9],[33,19]])]},
 file:{shapes:[rect(10,4,28,38),line([[17,16],[31,16]]),line([[17,24],[31,24]])]}
};
for(const spec of Object.values(families))validateSpec(spec);
const catalog={};
for(const [family,extensions] of Object.entries({
 text:'txt log rtf text',markdown:'md markdown mdx rst adoc org',document:'pdf doc docx odt ott pages ps eps tex latex wpd',presentation:'ppt pptx odp key',
 data:'csv tsv xls xlsx xlsm ods numbers json jsonl ndjson yaml yml toml xml ini conf cfg properties env',
 code:'js mjs cjs jsx ts tsx py pyw rb rs go c h cpp cc cxx hpp java kt kts swift cs fs fsharp php lua pl r scala dart vue svelte html htm css scss sass less sql ipynb graphql gql proto wasm',
 terminal:'sh bash zsh fish bat cmd ps1',config:'service socket timer desktop target gitignore editorconfig npmrc',
 archive:'zip tar tar.gz tar.bz2 tar.xz tgz tbz2 txz gz bz2 xz 7z rar zst lz lzma cab iso img',
 audio:'mp3 wav flac ogg opus m4a aac aiff wma mid midi',video:'mp4 mkv webm mov avi m4v mpg mpeg wmv ogv',app:'exe dll so dylib app appimage bin elf apk',font:'ttf otf woff woff2 eot',
 design:'svg ai psd xcf kra sketch fig blend obj stl glb gltf fbx step stp dxf dwg',database:'db sqlite sqlite3 mdb accdb',book:'epub mobi azw azw3 djvu',package:'deb rpm snap flatpak flatpakref flatpakrepo'
}))for(const ext of extensions.split(' '))catalog['ext:'+ext]={family,badge:ext.toUpperCase()};
for(const [key,family] of Object.entries({makefile:'terminal',dockerfile:'package',license:'text',readme:'markdown',changelog:'text',gitignore:'config',editorconfig:'config',npmrc:'config',env:'config'}))catalog['name:'+key]={family,badge:key.slice(0,8).toUpperCase()};
catalog['file:extensionless']={family:'file',badge:'FILE'};
module.exports={families,catalog};
