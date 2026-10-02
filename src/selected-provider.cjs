'use strict';
const {CodexProvider}=require('./codex-provider.cjs');
const {ClaudeProvider}=require('./claude-provider.cjs');const {APIProvider}=require('./api-provider.cjs');const {CATALOG,validateSelection}=require('./provider-catalog.cjs');const {error}=require('./provider-common.cjs');
class SelectedProvider{
 constructor(settings,agent='librarian',options={}){this.settings=settings;this.agent=agent;const selection=()=>this.configuration();this.codex=options.codex||new CodexProvider({selection});this.claude=options.claude||new ClaudeProvider({selection,...options.claudeOptions});this.api=options.api||new APIProvider({selection,key:()=>this.settings.secret(this.agent),...options.apiOptions});}
 configuration(){return this.settings.data.agents[this.agent].provider;}
 async status(){const current=this.configuration();try{return this.clean(await this.adapter().status());}catch(e){return{available:false,provider:CATALOG[current.type]?.label,model:current.model,reasoning:current.effort,code:e.code,message:this.settings.redact(e.message)};}}
 adapter(){const current=this.configuration();validateSelection(current);if(current.type==='codex-cli')return this.codex;if(current.type==='claude-cli')return this.claude;if(['openai-api','anthropic-api','gemini-api'].includes(current.type))return this.api;throw error('Unsupported selected provider. No fallback was used.','PROVIDER_CONFIG');}
 clean(value){if(typeof value==='string')return this.settings.redact(value);if(Array.isArray(value))return value.map(entry=>this.clean(entry));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,this.clean(entry)]));return value;}
 async plan(prompt,options){try{return this.clean(await this.adapter().plan(this.settings.redact(prompt),options));}catch(e){throw error(this.settings.redact(e.message),e.code||'PROVIDER');}}
 async designIcons(keys,options){this.settings.require('iconDesigner','designIcons');try{return this.clean(await this.adapter().designIcons(keys,options));}catch(e){throw error(this.settings.redact(e.message),e.code||'PROVIDER');}}
}
module.exports={SelectedProvider};
