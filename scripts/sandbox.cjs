'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const DISABLING_SWITCHES = new Set(['--no-sandbox','--disable-setuid-sandbox','--disable-namespace-sandbox','--disable-seccomp-filter-sandbox','--disable-gpu-sandbox','--single-process','--no-zygote','--disable-web-security']);
function fail(message) { throw Object.assign(new Error(message),{code:'SANDBOX_SETUP'}); }
function assertSandboxArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) fail('Launcher arguments must be strings.');
  for (const arg of args) if (DISABLING_SWITCHES.has(arg.split('=')[0])) fail(`Refusing sandbox-disabling argument: ${arg.split('=')[0]}`);
  return args;
}
async function validateHelper(file, { lstat = fs.lstat } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) fail('Sandbox helper must be an absolute local path.');
  file = path.resolve(file);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o4755) fail(`Sandbox helper is not a root:root regular file with mode4755: ${file}`);
  let parent = path.dirname(file);
  while (true) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) fail(`Sandbox helper parent must be root-owned and not writable by group/others: ${parent}`);
    if (parent === '/') break;
    parent = path.dirname(parent);
  }
  return file;
}
async function sandboxEnvironment({env=process.env,projectRoot=path.resolve(__dirname,'..'),lstat=fs.lstat,platform=process.platform}={}) {
  if (platform !== 'linux') fail('This VEYL launcher supports Ubuntu/Linux.');
  const next = {...env}; delete next.ELECTRON_RUN_AS_NODE;
  if (env.CHROME_DEVEL_SANDBOX !== undefined) {
    try { next.CHROME_DEVEL_SANDBOX = await validateHelper(env.CHROME_DEVEL_SANDBOX,{lstat}); }
    catch (error) { fail(`Configured CHROME_DEVEL_SANDBOX was refused: ${error.message}. Choose an existing trusted helper; nothing was changed.`); }
    return next;
  }
  const candidates = [path.join(projectRoot,'node_modules/electron/dist/chrome-sandbox'),'/opt/google/chrome/chrome-sandbox'];
  const failures=[];
  for (const candidate of candidates) {
    try { next.CHROME_DEVEL_SANDBOX=await validateHelper(candidate,{lstat});return next; }
    catch (error) { failures.push(`${candidate}: ${error.code==='ENOENT'?'not installed':error.message}`); }
  }
  fail(`No secure Chromium SUID helper is available.\n${failures.join('\n')}\nVEYL will not disable sandboxing or change system permissions. A properly installed trusted Chromium helper is required; set CHROME_DEVEL_SANDBOX to its absolute path once available.`);
}
module.exports={sandboxEnvironment,validateHelper,assertSandboxArguments};
