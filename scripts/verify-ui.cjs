'use strict';
const {sandboxEnvironment,assertSandboxArguments}=require('./sandbox.cjs');
// Native Electron integration checks. Run manually from the owning Architect session.
// The default never invokes an AI model; --live-librarian explicitly exercises configured Codex.
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'systemus-ui-verify-'));
  const home = path.join(root, 'home');
  for (const folder of ['Documents/nested', 'Pictures']) await fs.mkdir(path.join(home, folder), { recursive: true });
  await fs.writeFile(path.join(home, 'note.txt'), 'Preserve exact fixture bytes.');
  await fs.writeFile(path.join(home, 'Documents/nested/needle.txt'), 'needle');
  await fs.writeFile(path.join(home, '.hidden'), 'hidden fixture');
  await fs.writeFile(path.join(home, 'Pictures/sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=', 'base64'));
  const env = { ...process.env, SYSTEMUS_HOME: home, SYSTEMUS_USER_DATA: path.join(root, 'state'), SYSTEMUS_TRASH_ROOT: path.join(root, 'Trash') };
  delete env.ELECTRON_RUN_AS_NODE;
  // An existing verified sandbox helper may be supplied by the caller; sandbox is never disabled.
  const checks = [], errors = []; let app, passed=false;
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env: await sandboxEnvironment({env}), chromiumSandbox:true, timeout: 15000 });
    assertSandboxArguments(app.process().spawnargs);
    await app.evaluate(async ({clipboard,ClipboardItem}) => {
      const saved=await clipboard.read(),backup=[];
      globalThis.systemusClipboardDigest=async items=>{
        const records=[];for(const item of items)for(const type of item.types){const value=await item.getType(type);const bytes=value instanceof Blob?Buffer.from(await value.arrayBuffer()):Buffer.from(JSON.stringify(value));records.push([type,bytes.toString('base64')]);}
        return JSON.stringify(records.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1])));
      };
      for(const item of saved){if(!item.types.length)continue;const data={};for(const type of item.types)data[type]=await item.getType(type);backup.push(new ClipboardItem(data));}
      const digest=await globalThis.systemusClipboardDigest(backup);
      // Publish backup only after complete capture; an error must leave original clipboard untouched.
      globalThis.systemusSavedClipboard=backup;globalThis.systemusSavedClipboardDigest=digest;
    });
    const page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    const card = file => page.locator(`#pane-primary .file-card[data-path=${JSON.stringify(file)}]`);
    await card(path.join(home, 'note.txt')).waitFor();
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    const security = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(security.sandbox, true); assert.equal(security.contextIsolation, true); assert.equal(security.nodeIntegration, false); checks.push('real sandbox and isolated renderer');
    await page.locator('#hidden-toggle').click(); await card(path.join(home, '.hidden')).waitFor(); await page.locator('#hidden-toggle').click(); await card(path.join(home, '.hidden')).waitFor({ state: 'detached' });
    await page.locator('#view-list').click(); await page.locator('.detail-list').waitFor(); await page.locator('#view-grid').click(); checks.push('hidden visibility and detail/grid views');
    await page.locator('#new-tab').click(); assert.equal(await page.locator('.folder-tab').count(), 2); await page.locator('.folder-tab.active button').click();
    await page.locator('#dual-toggle').click(); await page.locator('#pane-secondary .file-card').first().waitFor(); await page.locator('#dual-toggle').click(); checks.push('tabs and independent second pane');
    await page.locator('#new-folder').click(); await page.locator('#dialog-fields input[name=name]').fill('Review folder'); await page.locator('#dialog-confirm').click(); await card(path.join(home, 'Review folder')).waitFor();
    assert.ok((await fs.stat(path.join(home, 'Review folder'))).isDirectory()); checks.push('folder creation dialog');
    await card(path.join(home, 'note.txt')).click(); await page.keyboard.press('F2'); await page.locator('#dialog-fields input[name=name]').fill('renamed.txt'); await page.locator('#dialog-confirm').click(); await card(path.join(home, 'renamed.txt')).waitFor(); assert.equal(await fs.readFile(path.join(home, 'renamed.txt'), 'utf8'), 'Preserve exact fixture bytes.'); checks.push('rename preserves bytes');
    await card(path.join(home, 'renamed.txt')).click(); await page.keyboard.press('Control+c'); await card(path.join(home, 'Documents')).dblclick(); await page.locator('#paste').click(); await card(path.join(home, 'Documents/renamed.txt')).waitFor(); assert.equal(await fs.readFile(path.join(home, 'Documents/renamed.txt'), 'utf8'), 'Preserve exact fixture bytes.');
    await page.locator('#undo').click(); await card(path.join(home, 'Documents/renamed.txt')).waitFor({ state: 'detached' }); await assert.rejects(fs.stat(path.join(home, 'Documents/renamed.txt')), { code: 'ENOENT' }); checks.push('copy/paste and guarded undo');
    await page.locator('.brand').click(); await card(path.join(home, 'renamed.txt')).waitFor(); await card(path.join(home, 'renamed.txt')).click(); await page.keyboard.press('Delete'); await page.locator('#dialog-cancel').click(); assert.equal(await fs.readFile(path.join(home, 'renamed.txt'), 'utf8'), 'Preserve exact fixture bytes.');
    await page.keyboard.press('Delete'); await page.locator('#dialog-confirm').click(); await card(path.join(home, 'renamed.txt')).waitFor({ state: 'detached' }); await assert.rejects(fs.stat(path.join(home, 'renamed.txt')), { code: 'ENOENT' }); checks.push('Trash cancel/explicit approval');
    await page.locator('#trash-place').click(); await page.locator('#pane-primary .file-card').first().waitFor(); await page.locator('#pane-primary .file-card').first().click(); await page.getByRole('button', { name: 'Restore', exact: true }).click(); await page.locator('#pane-primary .file-card').waitFor({ state: 'detached' }); assert.equal(await fs.readFile(path.join(home, 'renamed.txt'), 'utf8'), 'Preserve exact fixture bytes.'); checks.push('Trash restore through UI');
    await page.locator('#places .nav-item').filter({ hasText: 'Pictures' }).click(); await card(path.join(home, 'Pictures/sample.png')).waitFor();
    await page.waitForFunction(() => { const image = document.querySelector('.file-card img'); return image?.complete && image.naturalWidth > 0; }); await card(path.join(home, 'Pictures/sample.png')).click(); await page.locator('#inspector-toggle').click();
    await page.waitForFunction(() => { const image = document.querySelector('#inspector img'); return image?.complete && image.naturalWidth > 0; }); await page.locator('#close-inspector').click(); checks.push('decoded thumbnail/image preview');
    await page.locator('.brand').click(); await card(path.join(home, 'renamed.txt')).waitFor(); await card(path.join(home, 'renamed.txt')).click(); await page.locator('#inspector-toggle').click(); await page.locator('.preview-text').waitFor(); assert.match(await page.locator('.preview-text').innerText(), /Preserve exact fixture bytes/); await page.locator('#close-inspector').click(); checks.push('safe text preview');
    await page.locator('#search-mode').click(); await page.locator('#search-input').fill('needle'); await page.locator('#search-input').press('Enter'); await page.locator('.search-summary').filter({ hasText: 'Search complete' }).waitFor(); assert.equal(await page.locator('#pane-primary .file-card').count(), 1); assert.equal(await page.locator('#pane-primary .file-name').innerText(), 'needle.txt'); checks.push('recursive nested filename search');
    await page.locator('.brand').click();await card(path.join(home,'renamed.txt')).waitFor();
    await card(path.join(home,'renamed.txt')).click({button:'right'});await page.getByRole('menuitem',{name:'Create ZIP archive…',exact:true}).click();
    await page.locator('#dialog-fields input[name=name]').fill('fixture.zip');await page.locator('#dialog-confirm').click();await card(path.join(home,'fixture.zip')).waitFor();
    await card(path.join(home,'fixture.zip')).click({button:'right'});await page.getByRole('menuitem',{name:'Extract into new folder…',exact:true}).click();
    await page.locator('#dialog-fields input[name=name]').fill('unpacked');await page.locator('#dialog-confirm').click();await card(path.join(home,'unpacked')).waitFor();
    assert.equal(await fs.readFile(path.join(home,'unpacked','renamed.txt'),'utf8'),'Preserve exact fixture bytes.');checks.push('native archive menus and exact-byte extraction');
    await card(path.join(home,'renamed.txt')).click();await fs.writeFile(path.join(home,'external-watch.txt'),'external');await card(path.join(home,'external-watch.txt')).waitFor();
    assert.equal(await card(path.join(home,'renamed.txt')).getAttribute('aria-selected'),'true');checks.push('external folder refresh preserves selection');
    const external=path.join(root,'desktop-drop.txt');await fs.writeFile(external,'Dropped exact bytes.');
    await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='verification-drop-file';input.hidden=true;document.body.append(input);});
    await page.locator('#verification-drop-file').setInputFiles(external);
    await page.evaluate(()=>{const input=document.querySelector('#verification-drop-file');const data=new DataTransfer();data.items.add(input.files[0]);document.querySelector('#pane-primary').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));input.remove();});
    await card(path.join(home,'desktop-drop.txt')).waitFor();assert.equal(await fs.readFile(external,'utf8'),'Dropped exact bytes.');assert.equal(await fs.readFile(path.join(home,'desktop-drop.txt'),'utf8'),'Dropped exact bytes.');checks.push('real native File external drop defaults copy');
    if (process.argv.includes('--live-librarian')) {
      await page.locator('.brand').click(); await card(path.join(home, 'renamed.txt')).waitFor(); await card(path.join(home, 'renamed.txt')).click();
      if (!await page.locator('#librarian').isVisible()) await page.locator('#chat-toggle').click();
      await page.locator('#chat-send').waitFor(); await page.waitForFunction(() => !document.querySelector('#chat-send').disabled);
      await page.locator('#chat-input').fill('Rename the selected renamed.txt file to librarian-direct.txt. Preserve its exact contents.'); await page.locator('#chat-send').click();
      await card(path.join(home, 'librarian-direct.txt')).waitFor({ timeout: 180000 });
      await page.waitForFunction(() => !document.querySelector('#chat-send').disabled, null, { timeout: 20000 });
      assert.equal(await fs.readFile(path.join(home, 'librarian-direct.txt'), 'utf8'), 'Preserve exact fixture bytes.');
      assert.equal(await page.locator('.review-plan-button:enabled').count(), 0);
      assert.match(await page.locator('#chat-messages').innerText(), /Applied 1 step/);
      await page.locator('#undo').click(); await card(path.join(home, 'renamed.txt')).waitFor();
      assert.equal(await fs.readFile(path.join(home, 'renamed.txt'), 'utf8'), 'Preserve exact fixture bytes.');
      checks.push('LIVE Codex chat → direct guarded rename → actual result → Undo');
    }
    assert.deepEqual(errors, []); await page.screenshot({ path: path.join(root, 'verified-desktop.png') });
    await page.setViewportSize({ width: 1024, height: 768 }); await page.screenshot({ path: path.join(root, 'verified-1024.png') });
    passed=true;
  } catch (error) { process.stderr.write(`${JSON.stringify({ result: 'FAIL', checks, fixtureRoot: root, error: error.message })}\n`); throw error; }
  finally { if (app) { try { await app.evaluate(async ({clipboard})=>{if(globalThis.systemusSavedClipboard){if(globalThis.systemusSavedClipboard.length)await clipboard.write(globalThis.systemusSavedClipboard);else await clipboard.clear();if(await globalThis.systemusClipboardDigest(await clipboard.read())!==globalThis.systemusSavedClipboardDigest)throw new Error('OS clipboard restoration differed in formats or bytes.');}}); } finally { await app.close(); } } }
  if(passed)process.stdout.write(`${JSON.stringify({result:'PASS',checks,fixtureRoot:root,pageErrors:errors,liveAI:process.argv.includes('--live-librarian'),clipboardRestored:true,appClosed:true})}\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
