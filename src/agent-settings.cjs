'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');
const CAPABILITIES={librarian:['read','imageViewing','createEdit','copy','moveRename','trash','archives','restoreUndo'],iconDesigner:['designIcons']};
const PROVIDERS=['codex-cli','claude-cli','openai-api','anthropic-api','gemini-api'];
const {CODEX_MODELS,CATALOG,validateSelection}=require('./provider-catalog.cjs');
const ACTIONS={list:'read',images:'read',search:'read',properties:'read','read-text':'read',navigate:'read',select:'read',sort:'read',view:'read','edit-text':'createEdit','new-file':'createEdit','new-folder':'createEdit',copy:'copy',duplicate:'copy',move:'moveRename',rename:'moveRename','batch-rename':'moveRename',trash:'trash','move-images':'moveRename','copy-images':'copy','trash-images':'trash','archive-create':'archives','archive-extract':'archives',restore:'restoreUndo',undo:'restoreUndo'};
function fail(message,code='SETTINGS'){throw Object.assign(new Error(message),{code});}
function defaults(){return{accent:'#8800ff',version:1,agents:Object.fromEntries(Object.entries(CAPABILITIES).map(([agent,keys])=>[agent,{permissions:Object.fromEntries(keys.map(key=>[key,true])),provider:{type:'codex-cli',model:'gpt-6-luna',effort:'medium'}}]))};}
function validate(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!['accent','version','agents'].includes(key))||!/^#[0-9a-f]{6}$/i.test(data.accent)||!Number.isSafeInteger(data.version)||data.version<1||!data.agents||Object.keys(data.agents).length!==2)fail('Invalid VEYL settings.');
 for(const [agent,keys] of Object.entries(CAPABILITIES)){
  const entry=data.agents[agent];if(!entry||Object.keys(entry).sort().join(',')!=='permissions,provider'||Object.keys(entry.permissions||{}).length!==keys.length||keys.some(key=>typeof entry.permissions[key]!=='boolean'))fail('Invalid agent permissions.');
  const provider=entry.provider;if(!provider||Object.keys(provider).sort().join(',')!=='effort,model,type'||!PROVIDERS.includes(provider.type))fail('Invalid provider settings.');validateSelection(provider);
 }
 return data;
}
class AgentSettings{
 constructor({stateDir,safeStorage,onChange=()=>{}}={}){this.stateDir=stateDir;this.safeStorage=safeStorage;this.onChange=onChange;this.data=defaults();this.policyVersion=1;this.encrypted={};this.sessionKeys=new Map();this.warning=null;this.queue=Promise.resolve();}
 secure(){try{return Boolean(this.safeStorage?.isEncryptionAvailable()&&(process.platform!=='linux'||['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(this.safeStorage.getSelectedStorageBackend?.())));}catch{return false;}}
 key(agent){return`${agent}:${this.data.agents[agent].provider.type}`;}
 async initialize(){
  try{const file=path.join(this.stateDir,'agent-settings.json'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw new Error('Unsafe settings file');const raw=JSON.parse(await fs.readFile(file,'utf8'));this.data=validate(raw.settings);if(raw.encryptedKeys&&typeof raw.encryptedKeys==='object')for(const agent of Object.keys(CAPABILITIES))for(const provider of PROVIDERS.filter(p=>p.endsWith('-api'))){const key=`${agent}:${provider}`;if(typeof raw.encryptedKeys[key]==='string'&&raw.encryptedKeys[key].length<16384)this.encrypted[key]=raw.encryptedKeys[key];}this.policyVersion=this.data.version;}
  catch(error){if(error.code!=='ENOENT'){for(const agent of Object.values(this.data.agents))for(const key of Object.keys(agent.permissions))agent.permissions[key]=false;this.warning='Saved agent settings could not be verified. Agent permissions are disabled until you save reviewed settings; manual browsing remains available.';}}
  return this.public();
 }
 public(){return{...structuredClone(this.data),policyVersion:this.policyVersion,providers:PROVIDERS,providerCatalog:CATALOG,codexModels:CODEX_MODELS,capabilities:CAPABILITIES,secureStorage:this.secure(),warning:this.warning,secretState:Object.fromEntries(Object.keys(CAPABILITIES).map(agent=>{const key=this.key(agent);return[agent,{configured:this.sessionKeys.has(key)||Boolean(this.encrypted[key]),storage:this.sessionKeys.has(key)?'session':this.encrypted[key]?(this.secure()?'secure':'locked'):'none'}];}))};}
 require(agent,capability,version){if(!this.data.agents[agent]?.permissions[capability])fail(`VEYL permission “${capability}” is disabled for this agent.`,'PERMISSION_DENIED');if(version!==undefined&&version!==null&&version!==this.policyVersion)fail('VEYL permissions/provider changed during this request. Start a fresh request.','POLICY_CHANGED');}
 action(action,version){const capability=ACTIONS[action];if(!capability)fail('Unsupported agent action.','PERMISSION_DENIED');this.require('librarian',capability,version);}
 guard(action,version){return original=>{this.action(action,version);if(action==='undo'&&original)this.action(original,version);};}
 secret(agent){const key=this.key(agent);if(this.sessionKeys.has(key))return this.sessionKeys.get(key);if(this.encrypted[key]&&this.secure()){try{return this.safeStorage.decryptString(Buffer.from(this.encrypted[key],'base64'));}catch{fail('The saved API key cannot be unlocked. Enter it again in Settings.','SECRET_UNAVAILABLE');}}return null;}
 redact(text){let value=String(text);for(const name of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','CODEX_API_KEY','GH_TOKEN','GITHUB_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN'])if(process.env[name])value=value.split(process.env[name]).join('[redacted]');for(const secret of this.sessionKeys.values())value=value.split(secret).join('[redacted]');if(this.secure())for(const encrypted of Object.values(this.encrypted)){try{const secret=this.safeStorage.decryptString(Buffer.from(encrypted,'base64'));if(secret)value=value.split(secret).join('[redacted]');}catch{}}return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,}|Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*[^\s,;]+)/gi,'[redacted credential]');}
 update({accent,agents,secret,clearSecret,agent='librarian',version}={}){
  const run=async()=>{
   if(version!==this.data.version)fail('Settings changed in another view. Reopen Settings and try again.','SETTINGS_STALE');
   const candidate=validate({accent,agents,version:this.data.version+1});if(!Object.hasOwn(CAPABILITIES,agent))fail('Unknown agent.');
   if(secret!==undefined&&(typeof secret!=='string'||!secret||secret.length>4096||/[\r\n\0]/.test(secret)))fail('API key must be a bounded single-line value.');
   if((secret!==undefined||clearSecret)&&!candidate.agents[agent].provider.type.endsWith('-api'))fail('API keys belong only to the selected API provider, never CLI authentication.');
   const policyChanged=JSON.stringify(candidate.agents)!==JSON.stringify(this.data.agents)||secret!==undefined||Boolean(clearSecret);
   const key=`${agent}:${candidate.agents[agent].provider.type}`;
   if(clearSecret){delete this.encrypted[key];this.sessionKeys.delete(key);}
   if(secret!==undefined){if(this.secure()){this.encrypted[key]=this.safeStorage.encryptString(secret).toString('base64');this.sessionKeys.delete(key);}else this.sessionKeys.set(key,secret);}
   this.data=candidate;if(policyChanged){this.policyVersion++;this.onChange(this.public());}
   let tmp;
   try{await fs.mkdir(this.stateDir,{recursive:true,mode:0o700});tmp=path.join(this.stateDir,`agents-${randomUUID()}.tmp`);const payload=JSON.stringify({settings:this.data,encryptedKeys:this.encrypted});await fs.writeFile(tmp,payload,{flag:'wx',mode:0o600});await fs.rename(tmp,path.join(this.stateDir,'agent-settings.json'));if(await fs.readFile(path.join(this.stateDir,'agent-settings.json'),'utf8')!==payload)throw new Error('Settings readback mismatch');this.warning=this.secure()||!this.sessionKeys.size?null:'Secure OS storage is unavailable; API keys are held for this session only.';}
   catch{if(tmp)await fs.unlink(tmp).catch(()=>{});this.warning='Settings apply to this session, but could not be saved locally.';}
   return this.public();
  };const result=this.queue.then(run,run);this.queue=result.catch(()=>{});return result;
 }
}
module.exports={AgentSettings,CAPABILITIES,PROVIDERS,CODEX_MODELS,ACTIONS,defaults,validate};
