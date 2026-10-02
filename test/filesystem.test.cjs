'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FilesystemService, name, inside } = require('../src/filesystem.cjs');

async function fixture(t, limits) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'systemus-test-'));
  const home = path.join(root, 'home'); const out = path.join(home, 'out');
  await fs.mkdir(out, { recursive: true });
  const service = new FilesystemService({ home, stateDir: path.join(root, 'state'), trashRoot: path.join(root, 'Trash'), limits });
  t.after(async () => { service.cancelAll(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, home, out, service };
}
function bounded(promise, milliseconds = 3000) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Operation failed to settle within ${milliseconds}ms`)), milliseconds); })]).finally(() => clearTimeout(timer));
}

test('names reject traversal and invalid characters; containment is segment-aware', () => {
  for (const value of ['../file', '..', '.', '/tmp/x', 'a/b', 'a\\b', 'x\0y', 'a\nb', '']) assert.throws(() => name(value));
  assert.equal(name('ordinary photo 02.jpg'), 'ordinary photo 02.jpg');
  assert.equal(inside('/tmp/a', '/tmp/a/b'), true);
  assert.equal(inside('/tmp/a', '/tmp/ab'), false);
});

test('natural filename sorting, hidden toggle, filtering and stable pagination', async t => {
  const { home, service } = await fixture(t);
  for (const file of ['image10.jpg', 'image2.jpg', 'image1.jpg', '.hidden']) await fs.writeFile(path.join(home, file), file);
  const first = await service.list({ path: home, limit: 2 });
  assert.deepEqual(first.entries.map(e => e.name), ['out', 'image1.jpg']);
  assert.equal(first.total, 4); assert.equal(first.nextOffset, 2);
  const second = await service.list({ path: home, limit: 2, offset: first.nextOffset });
  assert.deepEqual(second.entries.map(e => e.name), ['image2.jpg', 'image10.jpg']);
  assert.equal(second.nextOffset, null);
  assert.equal((await service.list({ path: home, hidden: true })).total, 5);
  assert.equal((await service.list({ path: home, filter: 'IMAGE2' })).entries[0].name, 'image2.jpg');
});

test('folder enumeration and metadata sorting do not truncate at legacy resource caps', async t => {
  const { home, service } = await fixture(t, { list: 2, statSort: 2 });
  for (let n = 1; n <= 8; n++) await fs.writeFile(path.join(home, `file${n}.txt`), 'x'.repeat(n));
  const sorted = await service.list({ path: home, sort: 'size', direction: 'desc', limit: 3 });
  assert.equal(sorted.total, 9); assert.equal(sorted.truncated, false);
  assert.deepEqual(sorted.entries.map(e => e.name), ['out', 'file8.txt', 'file7.txt']);
  const last = await service.list({ path: home, sort: 'size', direction: 'desc', offset: 8 });
  assert.deepEqual(last.entries.map(e => e.name), ['file1.txt']);
});

test('copy settles and preserves content, including a multi-buffer file; undo removes only unchanged copy', async t => {
  const { home, out, service } = await fixture(t);
  const source = path.join(home, 'payload.bin'); const bytes = Buffer.alloc(2 * 1024 * 1024 + 19, 0x71);
  await fs.writeFile(source, bytes);
  const copied = await bounded(service.mutate({ action: 'copy', paths: [source], destination: out }));
  assert.equal(copied.errors.length, 0); assert.equal(copied.changes.length, 1);
  assert.deepEqual(await fs.readFile(path.join(out, 'payload.bin')), bytes);
  assert.deepEqual(await fs.readFile(source), bytes);
  const undone = await bounded(service.mutate({ action: 'undo' }));
  assert.equal(undone.errors.length, 0); await assert.rejects(fs.lstat(path.join(out, 'payload.bin')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(source), bytes);
});

test('copy never overwrites a file or a destination symlink', async t => {
  const { home, out, service } = await fixture(t);
  const source = path.join(home, 'same.txt'); const destination = path.join(out, 'same.txt');
  await fs.writeFile(source, 'source'); await fs.writeFile(destination, 'existing');
  const result = await service.mutate({ action: 'copy', paths: [source], destination: out });
  assert.equal(result.errors[0].code, 'EXISTS'); assert.equal(await fs.readFile(destination, 'utf8'), 'existing');
  await fs.unlink(destination); await fs.symlink(source, destination);
  const linked = await service.mutate({ action: 'move', paths: [source], destination: out });
  assert.equal(linked.errors[0].code, 'EXISTS'); assert.equal(await fs.readFile(source, 'utf8'), 'source');
});

test('directory transfer preserves nested files and symlinks, then can undo', async t => {
  const { home, out, service } = await fixture(t);
  const source = path.join(home, 'photos');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true });
  await fs.writeFile(path.join(source, 'nested', 'photo.txt'), 'photo');
  await fs.symlink('../../out', path.join(source, 'nested', 'shortcut'));
  const result = await bounded(service.mutate({ action: 'move', paths: [source], destination: out }));
  assert.equal(result.errors.length, 0);
  await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
  assert.equal(await fs.readlink(path.join(out, 'photos', 'nested', 'shortcut')), '../../out');
  assert.equal(await fs.readFile(path.join(out, 'photos', 'nested', 'photo.txt'), 'utf8'), 'photo');
  const undone = await bounded(service.mutate({ action: 'undo' }));
  assert.equal(undone.errors.length, 0); assert.equal(await fs.readFile(path.join(source, 'nested', 'photo.txt'), 'utf8'), 'photo');
});

test('copy into self or a symlink back into self is rejected without touching source', async t => {
  const { home, out, service } = await fixture(t);
  const source = path.join(home, 'tree'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'keep.txt'), 'keep');
  await fs.symlink(source, path.join(out, 'alias'));
  const result = await service.mutate({ action: 'move', paths: [source], destination: path.join(out, 'alias') });
  assert.equal(result.errors[0].code, 'SELF_MOVE'); assert.equal(await fs.readFile(path.join(source, 'keep.txt'), 'utf8'), 'keep');
});

test('a changed copy blocks undo instead of deleting a later edit', async t => {
  const { home, out, service } = await fixture(t);
  const source = path.join(home, 'note.txt'); await fs.writeFile(source, 'before');
  await service.mutate({ action: 'copy', paths: [source], destination: out });
  await fs.writeFile(path.join(out, 'note.txt'), 'later work');
  const result = await service.mutate({ action: 'undo' });
  assert.equal(result.errors[0].code, 'CHANGED'); assert.equal(result.undoAvailable, true);
  assert.equal(await fs.readFile(path.join(out, 'note.txt'), 'utf8'), 'later work');
});

test('source change during transfer preserves original and reports partial destination', async t => {
  const { home, out, service } = await fixture(t);
  const source = path.join(home, 'note.txt'); await fs.writeFile(source, 'before');
  service.nativeMoves = false; // Exercise the verified cross-device/copy-remove path deliberately.
  const originalCopy = service.copyTree.bind(service);
  service.copyTree = async (...args) => { const result = await originalCopy(...args); await fs.writeFile(source, 'changed during move'); return result; };
  const result = await service.mutate({ action: 'move', paths: [source], destination: out });
  assert.equal(result.errors[0].code, 'CHANGED'); assert.ok(result.errors[0].partial.destination);
  assert.equal(await fs.readFile(source, 'utf8'), 'changed during move'); assert.equal(await fs.readFile(path.join(out, 'note.txt'), 'utf8'), 'before');
});

test('same-device native move preserves directory inode and hardlinks without recursive copying', { skip: process.platform !== 'linux' }, async t => {
  const { home, out, service } = await fixture(t, { copyEntries: 1 });
  const source = path.join(home, 'large-tree'); await fs.mkdir(source);
  const first = path.join(source, 'first.txt'), second = path.join(source, 'hardlink.txt');
  await fs.writeFile(first, 'hardlink content'); await fs.link(first, second);
  const inode = (await fs.lstat(source)).ino, fileInode = (await fs.lstat(first)).ino;
  service.copyTree = async () => { throw new Error('Native directory move must not copy its contents'); };
  const moved = await bounded(service.mutate({ action: 'move', paths: [source], destination: out }));
  assert.equal(moved.errors.length, 0); assert.equal((await fs.lstat(path.join(out, 'large-tree'))).ino, inode);
  assert.equal((await fs.lstat(path.join(out, 'large-tree', 'first.txt'))).ino, fileInode);
  assert.equal((await fs.lstat(path.join(out, 'large-tree', 'hardlink.txt'))).ino, fileInode);
  const undone = await bounded(service.mutate({ action: 'undo' })); assert.equal(undone.errors.length, 0); assert.equal((await fs.lstat(source)).ino, inode);
});

test('restore rejects oversized selections rather than silently omitting entries', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.mutate({ action: 'restore', items: Array.from({ length: 501 }, () => ({ trashId: 'x', trashRoot: '/tmp' })) }), /between 1 and 500/);
});

test('partial multi-selection reports success and conflict separately', async t => {
  const { home, out, service } = await fixture(t);
  const first = path.join(home, 'first.txt'); const second = path.join(home, 'second.txt');
  await fs.writeFile(first, 'one'); await fs.writeFile(second, 'two'); await fs.writeFile(path.join(out, 'second.txt'), 'old');
  const result = await service.mutate({ action: 'copy', paths: [first, second], destination: out });
  assert.equal(result.changes.length, 1); assert.equal(result.errors.length, 1); assert.equal(result.partial, true);
  assert.equal(await fs.readFile(path.join(out, 'second.txt'), 'utf8'), 'old');
});

test('new file, folder, duplicate and batch rename enforce names and collision safety', async t => {
  const { home, service } = await fixture(t);
  await assert.rejects(service.mutate({ action: 'new-file', destination: home, name: '../escape' }));
  await service.mutate({ action: 'new-folder', destination: home, name: 'Folder' });
  await service.mutate({ action: 'new-file', destination: home, name: 'a.txt' });
  await fs.writeFile(path.join(home, 'a.txt'), 'a');
  const duplicate = await service.mutate({ action: 'duplicate', paths: [path.join(home, 'a.txt')] });
  assert.equal(path.basename(duplicate.changes[0].destination), 'a copy.txt');
  await fs.writeFile(path.join(home, 'Doc001.txt'), 'do not overwrite');
  await assert.rejects(service.mutate({ action: 'batch-rename', paths: [path.join(home, 'a.txt')], prefix: 'Doc' }), { code: 'EXISTS' });
  assert.equal(await fs.readFile(path.join(home, 'a.txt'), 'utf8'), 'a');
});

test('Trash requires one-use confirmation, writes local freedesktop metadata, and restores after service restart', async t => {
  const { root, home, service } = await fixture(t);
  const source = path.join(home, 'special name % 🪻.txt'); await fs.writeFile(source, 'recover me');
  await assert.rejects(service.mutate({ action: 'trash', paths: [source], confirmed: true }), { code: 'CONFIRMATION' });
  const confirmation = await service.prepareTrash([source]);
  const before = new Date();
  const trashed = await service.mutate({ action: 'trash', token: confirmation.token, confirmed: true });
  assert.equal(trashed.errors.length, 0); await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
  await assert.rejects(service.mutate({ action: 'trash', token: confirmation.token, confirmed: true }), { code: 'CONFIRMATION' });
  const info = await fs.readFile(path.join(root, 'Trash', 'info', `${trashed.changes[0].trashId}.trashinfo`), 'utf8');
  assert.match(info, /^\[Trash Info\]\nPath=/); assert.match(info, /DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
  const localDate = new Date(/^DeletionDate=(.*)$/m.exec(info)[1]);
  assert.ok(Math.abs(localDate.getTime() - before.getTime()) < 5000, 'DeletionDate represents local wall-clock time');
  const restarted = new FilesystemService({ home, trashRoot: path.join(root, 'Trash') });
  const listing = await restarted.listTrash(); assert.equal(listing.entries.length, 1); assert.equal(listing.entries[0].originalPath, source);
  const restored = await restarted.mutate({ action: 'restore', items: listing.entries });
  assert.equal(restored.errors.length, 0); assert.equal(await fs.readFile(source, 'utf8'), 'recover me');
  assert.equal((await restarted.listTrash()).entries.length, 0);
});

test('Trash rejects changed confirmation and restore refuses to overwrite a new file', async t => {
  const { home, service } = await fixture(t);
  const source = path.join(home, 'note.txt'); await fs.writeFile(source, 'original');
  const first = await service.prepareTrash([source]); await fs.writeFile(source, 'changed');
  const rejected = await service.mutate({ action: 'trash', token: first.token, confirmed: true });
  assert.equal(rejected.errors[0].code, 'CHANGED'); assert.equal(await fs.readFile(source, 'utf8'), 'changed');
  const second = await service.prepareTrash([source]); await service.mutate({ action: 'trash', token: second.token, confirmed: true });
  await fs.writeFile(source, 'replacement'); const items = (await service.listTrash()).entries;
  const restored = await service.mutate({ action: 'restore', items });
  assert.equal(restored.errors[0].code, 'EXISTS'); assert.equal(await fs.readFile(source, 'utf8'), 'replacement');
  assert.equal((await service.listTrash()).entries.length, 1);
});

test('Trash rejects unsafe symlink root and preserves selected file', async t => {
  const { root, home, service } = await fixture(t);
  const elsewhere = path.join(root, 'elsewhere'); await fs.mkdir(elsewhere); await fs.symlink(elsewhere, path.join(root, 'Trash'));
  const source = path.join(home, 'keep.txt'); await fs.writeFile(source, 'keep');
  const confirmation = await service.prepareTrash([source]); const result = await service.mutate({ action: 'trash', token: confirmation.token, confirmed: true });
  assert.equal(result.errors[0].code, 'UNSAFE_TRASH'); assert.equal(await fs.readFile(source, 'utf8'), 'keep');
});

test('bounded recursive search skips hidden files and symlink traversal, then supports cancellation', async t => {
  const { home, out, service } = await fixture(t);
  await fs.mkdir(path.join(home, 'nested')); await fs.writeFile(path.join(home, 'nested', 'needle.txt'), 'match');
  await fs.writeFile(path.join(home, '.needle'), 'hidden'); await fs.symlink(home, path.join(out, 'loop'));
  const updates = [];
  await bounded(new Promise((resolve, reject) => service.startSearch({ path: home, query: 'needle' }, update => { updates.push(update); if (update.done) update.error ? reject(new Error(update.error.message)) : resolve(); })));
  assert.deepEqual(updates.flatMap(update => update.entries).map(e => e.name), ['needle.txt']);
  const cancelled = await bounded(new Promise(resolve => { const job = service.startSearch({ path: home, query: 'needle' }, update => { if (update.done) resolve(update); }); service.cancelSearch(job.id); }));
  assert.equal(cancelled.cancelled, true);
});

test('preview treats HTML/SVG as text, limits large text, and refuses symlink media', async t => {
  const { home, service } = await fixture(t);
  const html = path.join(home, 'untrusted.html'); await fs.writeFile(html, '<script>alert(1)</script>');
  const preview = await service.preview(html); assert.equal(preview.type, 'text'); assert.equal(preview.text, '<script>alert(1)</script>');
  const huge = path.join(home, 'huge.txt'); await fs.writeFile(huge, 'x'.repeat(400000));
  assert.equal((await service.preview(huge)).truncated, true);
  await fs.symlink(html, path.join(home, 'link.png')); assert.equal((await service.preview(path.join(home, 'link.png'))).type, 'none');
});

test('queued conflicting writers serialize and preserve exactly one result', async t => {
  const { home, service } = await fixture(t);
  const results = await Promise.allSettled([service.mutate({ action: 'new-file', destination: home, name: 'once.txt' }), service.mutate({ action: 'new-file', destination: home, name: 'once.txt' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected')[0].reason.code, 'EEXIST');
});

test('real FIFO text/image names never block preview or pass media/transfer policy', { timeout: 5000 }, async t => {
  const { home, out, service } = await fixture(t);
  const exec = require('node:util').promisify(require('node:child_process').execFile);
  for (const filename of ['pipe.txt', 'pipe.png']) {
    const file = path.join(home, filename); await exec('/usr/bin/mkfifo', ['--', file], {timeout:1000});
    const entry = await service.entry(file); assert.equal(entry.type, 'special');
    assert.equal((await bounded(service.preview(file), 500)).type, 'none');
    await assert.rejects(bounded(service.mediaFile(file,entry.identity),500));
    const moved = await bounded(service.mutate({action:'move',paths:[file],destination:out}),500);
    assert.equal(moved.errors[0].code,'UNSUPPORTED');assert.equal((await fs.lstat(file)).isFIFO(),true);
  }
});

test('regular text replaced by a real FIFO before open settles with changed-file refusal', {timeout:5000}, async t=>{
 const {home,service}=await fixture(t);const file=path.join(home,'race.txt');await fs.writeFile(file,'ordinary');
 const original=service.entry.bind(service);const exec=require('node:util').promisify(require('node:child_process').execFile);
 service.entry=async requested=>{const result=await original(requested);if(requested===file){await fs.unlink(file);await exec('/usr/bin/mkfifo',['--',file],{timeout:1000});}return result;};
 await assert.rejects(bounded(service.preview(file),500),{code:'CHANGED'});assert.equal((await fs.lstat(file)).isFIFO(),true);
});
