'use strict';
const {sandboxEnvironment,assertSandboxArguments}=require('./sandbox.cjs');
// Parent-run native regression. Disposable fixtures only; no AI or clipboard writes.
const {_electron:electron}=require('playwright-core');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'systemus-large-ui-'));const home=path.join(root,'home');await fs.mkdir(home);
 for(let offset=0;offset<1320;offset+=64)await Promise.all(Array.from({length:Math.min(64,1320-offset)},(_,n)=>fs.writeFile(path.join(home,`file${String(offset+n).padStart(4,'0')}.txt`),`fixture-${offset+n}`)));
 const external=path.join(root,'z-move-me.txt');await fs.writeFile(external,'Exact moved fixture bytes.');
 const env={...process.env,SYSTEMUS_HOME:home,SYSTEMUS_USER_DATA:path.join(root,'state'),SYSTEMUS_TRASH_ROOT:path.join(root,'Trash')};delete env.ELECTRON_RUN_AS_NODE;
 let app,passed=false;const errors=[],checks=[];
 try{
  app=await electron.launch({executablePath:require('electron'),args:[path.resolve(__dirname,'..')],env:await sandboxEnvironment({env}),chromiumSandbox:true,timeout:15000});assertSandboxArguments(app.process().spawnargs);const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const cards=page.locator('#pane-primary .file-card');await cards.first().waitFor();await page.locator('#view-list').click();
  for(let expected=480;expected<=1440;expected+=240){await page.locator('#pane-primary .load-more').click();await page.waitForFunction(count=>document.querySelectorAll('#pane-primary .file-card').length>=count,Math.min(expected,1320));}
  assert.equal(await cards.count(),1320);checks.push('all 1320 files loaded through six bounded pages');
  const selected=path.join(home,'file1250.txt');await page.locator(`#pane-primary .file-card[data-path=${JSON.stringify(selected)}]`).click();
  await page.evaluate(()=>{document.querySelector('#pane-primary .file-scroll').scrollTop=4200;});
  const scroll=await page.locator('#pane-primary .file-scroll').evaluate(node=>node.scrollTop);
  // An external metadata change past the first 1000 entries preserves the entire loaded window.
  await fs.writeFile(selected,'metadata changed after initial listing');
  await page.waitForFunction(file=>document.querySelector(`#pane-primary .file-card[data-path="${file}"] .file-meta`)?.textContent.includes('38 B'),selected);
  assert.equal(await cards.count(),1320);assert.equal(await page.locator(`#pane-primary .file-card[data-path=${JSON.stringify(selected)}]`).getAttribute('aria-selected'),'true');
  assert.ok(Math.abs(await page.locator('#pane-primary .file-scroll').evaluate(node=>node.scrollTop)-scroll)<10);checks.push('late metadata refresh preserves selection and scroll');
  await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='large-folder-drop';input.hidden=true;document.body.append(input);});await page.locator('#large-folder-drop').setInputFiles(external);
  const drop=()=>page.evaluate(()=>{const input=document.querySelector('#large-folder-drop'),data=new DataTransfer();data.items.add(input.files[0]);document.querySelector('#pane-primary').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,shiftKey:true}));});
  await drop();await page.locator('#dialog-cancel').click();assert.equal(await fs.readFile(external,'utf8'),'Exact moved fixture bytes.');await assert.rejects(fs.lstat(path.join(home,'z-move-me.txt')),{code:'ENOENT'});checks.push('external move cancellation preserves source');
  await drop();await page.locator('#dialog-confirm').click();const moved=page.locator(`#pane-primary .file-card[data-path=${JSON.stringify(path.join(home,'z-move-me.txt'))}]`);await moved.waitFor();
  assert.equal(await cards.count(),1321);assert.equal(await moved.getAttribute('aria-selected'),'true');assert.equal(await fs.readFile(path.join(home,'z-move-me.txt'),'utf8'),'Exact moved fixture bytes.');await assert.rejects(fs.lstat(external),{code:'ENOENT'});
  assert.ok(Math.abs(await page.locator('#pane-primary .file-scroll').evaluate(node=>node.scrollTop)-scroll)<10);checks.push('reviewed move retains loaded capacity, scroll, and selects actual target');
  await page.locator('#undo').click();await moved.waitFor({state:'detached'});assert.equal(await cards.count(),1320);assert.equal(await fs.readFile(external,'utf8'),'Exact moved fixture bytes.');checks.push('undo retains large loaded window and exact bytes');
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(root,'large-folder.png')});passed=true;
 }catch(error){process.stderr.write(JSON.stringify({result:'FAIL',checks,fixtureRoot:root,error:error.message})+'\n');throw error;}
 finally{if(app)await app.close();}
 if(passed)process.stdout.write(JSON.stringify({result:'PASS',checks,fixtureRoot:root,pageErrors:errors,appClosed:true})+'\n');
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
