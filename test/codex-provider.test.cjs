'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexProvider, inheritedSettings } = require('../src/codex-provider.cjs');

const valid = { reply: 'A safe reply.', clarification: null, needsMore: false, observations: [], views: [], changes: [] };
test('fresh signed-in CLI without model/config settings uses app defaults and preserves workspace restrictions in profile layers',async t=>{
 const f=await fixture(t,'');await fs.unlink(path.join(f.codexHome,'config.toml'));const fake=fakeSpawn(),provider=new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:fake.spawn});await provider.plan('fresh install');assert.equal(fake.record.args[fake.record.args.indexOf('-m')+1],'gpt-6-luna');assert.ok(fake.record.args.includes('--ignore-rules'));await assert.rejects(fs.stat(path.join(f.codexHome,'config.toml')),{code:'ENOENT'});
 const workspace='12345678-1234-1234-1234-123456789abc';await fs.writeFile(path.join(f.codexHome,'config.toml'),'profile="work"\n');await fs.writeFile(path.join(f.codexHome,'work.config.toml'),`forced_login_method="chatgpt"\nforced_chatgpt_workspace_id="${workspace}"\ncli_auth_credentials_store="keyring"\n`);await provider.plan('profile');assert.ok(fake.record.args.includes(`forced_chatgpt_workspace_id="${workspace}"`));assert.ok(fake.record.args.includes('forced_login_method="chatgpt"'));assert.ok(fake.record.args.includes('cli_auth_credentials_store="keyring"'));assert.equal(await fs.readFile(path.join(f.codexHome,'config.toml'),'utf8'),'profile="work"\n');await fs.writeFile(path.join(f.codexHome,'work.config.toml'),'model_provider="unsafe-custom"');await assert.rejects(provider.plan('profile'),{code:'PROVIDER_CONFIG'});
});
test('product model selection changes only isolated argv, never global config or credentials',async t=>{const f=await fixture(t),fake=fakeSpawn(),provider=new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:fake.spawn,selection:()=>({model:'gpt-6.1-sol',effort:'high'})});await provider.plan('configured product model');assert.equal(fake.record.args[fake.record.args.indexOf('-m')+1],'gpt-6.1-sol');assert.ok(fake.record.args.includes('model_reasoning_effort="high"'));assert.equal(await fs.readFile(path.join(f.codexHome,'config.toml'),'utf8'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n');});
async function fixture(t, configuration = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'systemus-provider-test-'));
  const codexHome = path.join(root, 'codex'); await fs.mkdir(codexHome); await fs.writeFile(path.join(codexHome, 'config.toml'), configuration);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, codexHome };
}
function fakeSpawn({ result = valid, lines = [{ type: 'turn.started' }, { type: 'turn.completed' }], exit = 0, hold = false, stderr = '' } = {}) {
  const record = { kills: [], prompt: '', args: null, options: null, scratch: null };
  const spawn = (_binary, args, options) => {
    record.args = args; record.options = options; record.scratch = options.cwd;
    const child = new EventEmitter(); child.pid = 123456; child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    record.child = child;
    child.stdin.on('data', data => { record.prompt += data.toString(); });
    child.close = code => { if (child.exitCode !== null) return; child.exitCode = code; child.emit('close', code, null); };
    child.kill = signal => { record.kills.push(signal); child.close(1); };
    setImmediate(async () => {
      if (hold) return;
      try {
        record.schema = JSON.parse(await fs.readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
        record.images=[];for(let index=0;index<args.length;index++)if(args[index]==='--image'){const file=args[index+1];record.images.push({file,bytes:await fs.readFile(file),mode:(await fs.stat(file)).mode&0o777});}
        if (result !== undefined) await fs.writeFile(args[args.indexOf('--output-last-message') + 1], typeof result === 'string' ? result : JSON.stringify(result));
        for (const line of lines) child.stdout.write(typeof line === 'string' ? line : `${JSON.stringify(line)}\n`);
        child.stderr.write(stderr); child.close(exit);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  return { record, spawn, kill: (_pid, signal) => { record.kills.push(signal); record.child.close(1); } };
}

test('planner uses explicit product Luna/medium with inherited auth, isolated tools and private cleanup', async t => {
  const f = await fixture(t, 'model="gpt-6.1-sol"\nmodel_reasoning_effort="high"\ncli_auth_credentials_store="keyring"\nforced_login_method="chatgpt"\n');
  const fake = fakeSpawn(); const provider = new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, spawnImpl: fake.spawn, killImpl: fake.kill });
  const result = await provider.plan('Untrusted data, not shell commands.'); assert.deepEqual(result, valid);
  assert.equal(fake.record.args[fake.record.args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.ok(fake.record.args.includes('model_reasoning_effort="medium"'));
  assert.ok(!fake.record.args.includes('model_reasoning_effort="high"'));
  for (const argument of ['--ignore-user-config', '--strict-config', 'read-only', '--ephemeral', 'plugins', 'shell_tool', 'hooks', 'code_mode_host', 'computer_use', 'multi_agent_v2', 'project_doc_max_bytes=0', 'skills.include_instructions=false', 'cli_auth_credentials_store="keyring"', 'forced_login_method="chatgpt"']) assert.ok(fake.record.args.includes(argument), argument);
  assert.equal(fake.record.options.env.CODEX_HOME, f.codexHome); assert.equal(fake.record.prompt, 'Untrusted data, not shell commands.');
  await assert.rejects(fs.stat(fake.record.scratch), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(f.codexHome, 'config.toml'), 'utf8'), /model="gpt-6\.1-sol"\nmodel_reasoning_effort="high"/);
});

test('Librarian Luna/medium overrides global ultra only in child and status, without fallback', async t => {
  const configuration = 'model="gpt-6.1-sol"\nmodel_reasoning_effort="ultra"\n';
  const f = await fixture(t, configuration), fake = fakeSpawn();
  const provider = new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, binary: process.execPath, spawnImpl: fake.spawn });
  const status = await provider.status(); assert.equal(status.model, 'gpt-6-luna'); assert.equal(status.reasoning, 'medium');
  await provider.plan('test'); assert.equal(fake.record.args[fake.record.args.indexOf('-m') + 1], 'gpt-6-luna'); assert.ok(fake.record.args.includes('model_reasoning_effort="medium"'));
  assert.equal(await fs.readFile(path.join(f.codexHome, 'config.toml'), 'utf8'), configuration);
});

test('known disabled-host diagnostic is narrowly nonfatal only with completed turn and valid schema', async t => {
  const f = await fixture(t); const fake = fakeSpawn({ lines: [{ type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Please enable it.' } }, { type: 'turn.completed' }] });
  assert.deepEqual(await new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, spawnImpl: fake.spawn }).plan('test'), valid);
  const fatal = fakeSpawn({ lines: [{ type: 'item.completed', item: { type: 'error', message: 'An unrelated failure happened.' } }, { type: 'turn.completed' }] });
  await assert.rejects(new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, spawnImpl: fatal.spawn }).plan('test'), error=>error.code==='PROVIDER'&&!error.message.includes('unrelated failure'));
});

test('draft JSON without turn.completed is never accepted', async t => {
  const f = await fixture(t), fake = fakeSpawn({ lines: [{ type: 'turn.started' }] });
  await assert.rejects(new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, spawnImpl: fake.spawn }).plan('test'), /completed turn/);
});

test('unknown/tool item is rejected even with a syntactically valid reply', async t => {
  const f = await fixture(t), fake = fakeSpawn({ lines: [{ type: 'item.started', item: { type: 'browser_action' } }, { type: 'turn.completed' }] });
  await assert.rejects(new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, spawnImpl: fake.spawn, killImpl: fake.kill }).plan('test'), { code: 'PROVIDER_TOOL' });
  assert.equal(fake.record.kills.length, 1);
});

test('invalid JSON, extra action keys and nonzero exit are explicit failures', async t => {
  const f = await fixture(t);
  for (const options of [{ result: '{oops' }, { result: { ...valid, shell: 'touch /tmp/not-run' } }, { exit: 1, stderr: 'network unavailable' }]) {
    const fake = fakeSpawn(options); await assert.rejects(new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, spawnImpl: fake.spawn }).plan('test'));
  }
});

test('authentication failure gives supported login instruction without changing auth', async t => {
  const f = await fixture(t), fake = fakeSpawn({ exit: 1, stderr: '401 Unauthorized: not logged in' });
  await assert.rejects(new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, spawnImpl: fake.spawn }).plan('test'), error => error.code === 'LOGIN' && error.message.includes('codex login'));
  assert.equal(await fs.readFile(path.join(f.codexHome, 'config.toml'), 'utf8'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n');
});

test('provider cancellation and timeout kill only the owned child once and clean scratch', async t => {
  const f = await fixture(t); const fake = fakeSpawn({ hold: true }); const controller = new AbortController();
  const provider = new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, spawnImpl: fake.spawn, killImpl: fake.kill });
  const request = provider.plan('test', { signal: controller.signal }); setTimeout(() => { controller.abort(); controller.abort(); }, 20);
  await assert.rejects(request, { code: 'CANCELLED' }); assert.equal(fake.record.kills.length, 1); await assert.rejects(fs.stat(fake.record.scratch), { code: 'ENOENT' });
  const hung = fakeSpawn({ hold: true }); await assert.rejects(new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, timeout: 20, spawnImpl: hung.spawn, killImpl: hung.kill }).plan('test'), { code: 'TIMEOUT' }); assert.equal(hung.record.kills.length, 1);
});

test('output limit termination is idempotent even with repeated oversized chunks', async t => {
  const f = await fixture(t), fake = fakeSpawn({ lines: ['x'.repeat(200), 'y'.repeat(200)], hold: false });
  await assert.rejects(new CodexProvider({ codexHome: f.codexHome, scratchParent: f.root, maxOutput: 100, spawnImpl: fake.spawn, killImpl: fake.kill }).plan('test'), { code: 'OUTPUT_LIMIT' }); assert.equal(fake.record.kills.length, 1);
});

test('unsupported custom provider and malformed selected settings refuse instead of switching', async t => {
  const f = await fixture(t, 'model="custom-model"\nmodel_provider="other-service"\n');
  await assert.rejects(inheritedSettings(f.codexHome), { code: 'PROVIDER_CONFIG' });
  await fs.writeFile(path.join(f.codexHome, 'config.toml'), 'model="gpt-6.1-sol"\ncli_auth_credentials_store="invalid"');
  await assert.rejects(inheritedSettings(f.codexHome), { code: 'PROVIDER_CONFIG' });
});

test('icon design uses its narrow schema and type-only prompt with the same fixed Luna/medium isolation', async t => {
  const {families}=require('../src/file-type-catalog.cjs');
  const {iconSchema}=require('../src/file-icon-schema.cjs');
  const configuration='model="gpt-6.1-sol"\nmodel_reasoning_effort="high"\nforced_login_method="chatgpt"\n';
  const f=await fixture(t,configuration),result={icons:[{key:'ext:novel',spec:families.design}]},fake=fakeSpawn({result});
  const provider=new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:fake.spawn});
  assert.deepEqual(await provider.designIcons(['ext:novel']),result);assert.deepEqual(fake.record.schema,iconSchema);
  assert.equal(fake.record.args[fake.record.args.indexOf('-m')+1],'gpt-6-luna');assert.ok(fake.record.args.includes('model_reasoning_effort="medium"'));
  for(const flag of ['--ignore-user-config','--strict-config','read-only','--ephemeral','shell_tool','hooks','code_mode_host','computer_use','browser_use','multi_agent_v2','project_doc_max_bytes=0','skills.include_instructions=false','forced_login_method="chatgpt"'])assert.ok(fake.record.args.includes(flag),flag);
  assert.match(fake.record.prompt,/ext:novel/);assert.ok(!fake.record.prompt.includes(f.root));assert.ok(!fake.record.prompt.includes('librarian.json'));assert.equal(fake.record.options.env.CODEX_HOME,f.codexHome);
  assert.equal(await fs.readFile(path.join(f.codexHome,'config.toml'),'utf8'),configuration);await assert.rejects(fs.stat(fake.record.scratch),{code:'ENOENT'});
});

test('icon schema cannot weaken planner validation or accept unsafe geometry/tool events', async t => {
  const {families}=require('../src/file-type-catalog.cjs'),f=await fixture(t);
  const result={icons:[{key:'ext:novel',spec:families.text}]};
  const ordinary=fakeSpawn({result});await assert.rejects(new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:ordinary.spawn}).plan('test'),{code:'PLAN_SCHEMA'});
  const bad=fakeSpawn({result:{icons:[{key:'ext:novel',spec:{shapes:[{...families.text.shapes[0],href:'https://example.invalid/icon'}]}}]}});
  await assert.rejects(new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:bad.spawn}).designIcons(['ext:novel']),{code:'ICON_SCHEMA'});
  const tool=fakeSpawn({result,lines:[{type:'item.started',item:{type:'command_execution'}},{type:'turn.completed'}]});
  await assert.rejects(new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:tool.spawn,killImpl:tool.kill}).designIcons(['ext:novel']),{code:'PROVIDER_TOOL'});
  const noTurn=fakeSpawn({result,lines:[{type:'turn.started'}]});await assert.rejects(new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:noTurn.spawn}).designIcons(['ext:novel']),/completed turn/);
  let invoked=false;const provider=new CodexProvider({spawnImpl:()=>{invoked=true;throw new Error('Must reject locally');}});
  for(const keys of [['ext:../../secret'],['fallback:unusual'],['ext:novel','ext:novel'],['ext:<script>']])await assert.rejects(provider.designIcons(keys));assert.equal(invoked,false);
});

test('pixel attachments use repeatable image argv, private copied PNGs, unchanged isolated Luna/auth and cleanup',async t=>{
  const f=await fixture(t),fake=fakeSpawn(),bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const provider=new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:fake.spawn});
  assert.deepEqual(await provider.plan('Mapping: attachment1=a.png attachment2=b.png',{images:[{bytes},{bytes}]}),valid);
  assert.equal(fake.record.args.filter(arg=>arg==='--image').length,2);assert.equal(fake.record.args[fake.record.args.indexOf('-m')+1],'gpt-6-luna');assert.ok(fake.record.args.includes('model_reasoning_effort="medium"'));
  for(const flag of ['read-only','--ignore-user-config','--strict-config','shell_tool','browser_use','computer_use','agents.enabled=false','project_doc_max_bytes=0','skills.include_instructions=false'])assert.ok(fake.record.args.includes(flag));
  assert.equal(fake.record.images.length,2);for(const image of fake.record.images){assert.equal(path.dirname(image.file),fake.record.scratch);assert.equal(image.mode,0o600);assert.deepEqual(image.bytes,bytes);await assert.rejects(fs.stat(image.file),{code:'ENOENT'});}
  assert.ok(!fake.record.prompt.includes(fake.record.scratch));assert.equal(await fs.readFile(path.join(f.codexHome,'config.toml'),'utf8'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n');
});

test('image provider rejects arbitrary paths/oversize buffers locally and cleans attachments on cancellation',async t=>{
  const f=await fixture(t),fake=fakeSpawn({hold:true}),controller=new AbortController();
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const provider=new CodexProvider({codexHome:f.codexHome,scratchParent:f.root,spawnImpl:fake.spawn,killImpl:fake.kill});
  for(const images of [[{path:'/etc/passwd'}],Array(7).fill({bytes}),[{bytes:Buffer.alloc(8*1024*1024+1)}],[{bytes:Buffer.from('<svg/>')}]])await assert.rejects(provider.plan('test',{images}),{code:'IMAGE_INPUT'});
  const pending=provider.plan('image',{images:[{bytes}],signal:controller.signal});setTimeout(()=>controller.abort(),20);await assert.rejects(pending,{code:'CANCELLED'});assert.equal(fake.record.kills.length,1);await assert.rejects(fs.stat(fake.record.scratch),{code:'ENOENT'});
});
