#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {sandboxEnvironment,assertSandboxArguments} = require('./sandbox.cjs');
async function launch({env=process.env,projectRoot=path.resolve(__dirname,'..'),spawnImpl=spawn,resolveEnvironment=sandboxEnvironment,args=process.argv.slice(2)}={}) {
  assertSandboxArguments(args);
  if(args.length)throw new Error('VEYL start accepts no extra Chromium flags. Use the explorer path bar to choose a folder.');
  const launchEnv=await resolveEnvironment({env,projectRoot});
  const executable=path.join(projectRoot,'node_modules/electron/dist/electron');
  await fs.access(executable,constants.X_OK);
  const argv=assertSandboxArguments([projectRoot,'--class=io.github.SketchOTP.VEYL']);
  // Desktop environments may omit ~/.local/bin. Preserve existing PATH and add this exact Node directory for saved Codex CLI access.
  const nodeDir=path.dirname(process.execPath);
  const userBin=path.join(os.homedir(),'.local','bin');
  launchEnv.PATH=[nodeDir,userBin,...(launchEnv.PATH||'/usr/local/bin:/usr/bin:/bin').split(path.delimiter).filter(dir=>dir!==nodeDir&&dir!==userBin)].join(path.delimiter);
  return spawnImpl(executable,argv,{cwd:projectRoot,env:launchEnv,stdio:'inherit',shell:false});
}
async function run() {
  const child=await launch();
  const forward=signal=>{if(child.exitCode===null&&!child.killed)child.kill(signal);};
  const interrupt=()=>forward('SIGINT'),terminate=()=>forward('SIGTERM');
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  child.once('error',error=>{process.stderr.write(`VEYL launch failed: ${error.message}\n`);process.exitCode=1;});
  child.once('exit',(code,signal)=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);process.exitCode=code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1);});
}
if(require.main===module)run().catch(error=>{process.stderr.write(`VEYL launch failed: ${error.message}\n`);process.exitCode=1;});
module.exports={launch,run};
