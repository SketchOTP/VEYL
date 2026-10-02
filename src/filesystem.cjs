'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const TYPES = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico']),
  audio: new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']),
  video: new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv']),
  text: new Set(['txt', 'md', 'json', 'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'xml', 'yaml', 'yml', 'csv', 'log', 'py', 'sh', 'toml', 'ini', 'conf', 'rs', 'go', 'c', 'h', 'cpp', 'svg']),
  archive: new Set(['zip', 'gz', 'tar', 'xz', 'bz2', '7z', 'rar'])
};
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg', pdf: 'application/pdf' };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const sleepTurn = () => new Promise(resolve => setImmediate(resolve));

function fail(message, code = 'INVALID') { const error = new Error(message); error.code = code; throw error; }
function absolute(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || value.includes('\0') || !path.isAbsolute(value)) fail('Choose an absolute filesystem path.');
  return path.resolve(value);
}
function name(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\0\r\n]/.test(value) || Buffer.byteLength(value) > 255) fail('Use a filename without slashes, newlines, or traversal segments.');
  return value;
}
function inside(parent, child) { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function identity(stat) { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
function kind(file, stat) {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'folder';
  if (!stat.isFile()) return 'special';
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  for (const [type, extensions] of Object.entries(TYPES)) if (extensions.has(ext)) return type;
  return stat.isFile() ? 'file' : 'special';
}
async function exists(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function mapLimit(items, limit, mapper) {
  let next = 0;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await mapper(items[index], index); }
  }));
  return result;
}
function describeError(error) { return { code: error.code || 'ERROR', message: error.message || String(error) }; }

class FilesystemService {
  constructor({ home = os.homedir(), stateDir, trashRoot, limits = {}, nativeMoves = process.platform === 'linux' } = {}) {
    this.home = absolute(home);
    this.stateDir = stateDir ? absolute(stateDir) : null;
    this.trashOverride = trashRoot ? absolute(trashRoot) : null;
    this.limits = { copyEntries: 2000000, ...limits };
    this.nativeMoves = nativeMoves;
    this.queue = Promise.resolve();
    this.history = [];
    this.searches = new Map();
    this.trashRoots = new Set();
    this.confirmations = new Map();
    this.listings = new Map();
    this.listCache = new Map();
    this.archives = new (require('./archives.cjs').Archives)(this);
    this.textEdits = new (require('./text-edits.cjs').TextEdits)(this);
  }

  async canonical(file) {
    file = absolute(file);
    // Resolve the parent, retaining the final symlink as an entry rather than following it.
    return path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  }

  async directory(file) {
    const resolved = await fs.realpath(absolute(file));
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory()) fail('This path is not a folder.', 'NOT_DIRECTORY');
    return resolved;
  }

  protect(file) {
    const protectedRoots = ['/', '/home', this.home, '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/run', '/var', '/tmp'];
    if (protectedRoots.includes(file) || (this.stateDir && (inside(this.stateDir, file) || inside(file, this.stateDir)))) fail('This location is protected from file operations.', 'PROTECTED');
    for (const root of this.trashRoots) if (inside(root, file) || inside(file, root)) fail('Use the Trash restore action for this location.', 'PROTECTED');
  }

  async entry(file) {
    file = absolute(file);
    const stat = await fs.lstat(file);
    const type = kind(file, stat);
    let target = null;
    let navigable = type === 'folder';
    if (type === 'symlink') {
      target = await fs.readlink(file);
      try { navigable = (await fs.stat(file)).isDirectory(); } catch { /* Broken links remain visible. */ }
    }
    return { path: file, name: path.basename(file), type, size: stat.size, modified: stat.mtimeMs, created: stat.birthtimeMs, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, identity: identity(stat), target, navigable, extension: path.extname(file).slice(1).toLowerCase() };
  }

  async list(options = {}, emit = () => {}) {
    options.guard?.();
    const folder = await this.directory(options.path || this.home);
    const offset = Math.max(0, Math.min(Number(options.offset) || 0, Number.MAX_SAFE_INTEGER));
    const limit = Math.max(1, Math.min(Number(options.limit) || 240, 1000));
    const sort = ['name', 'modified', 'size', 'type'].includes(options.sort) ? options.sort : 'name';
    const direction = options.direction === 'desc' ? -1 : 1;
    const filter = typeof options.filter === 'string' ? options.filter.toLocaleLowerCase().slice(0, 1024) : '';
    const id = String(options.requestId || randomUUID()).slice(0, 100);
    const controller = new AbortController(); this.listings.set(id, controller);
    const check = () => { options.guard?.(); if (controller.signal.aborted) fail('Folder loading cancelled.', 'CANCELLED'); };
    try {
      const folderSignature = identity(await fs.stat(folder));
      const key = `${folder}\0${Boolean(options.hidden)}\0${filter}${options.exclude ? '\0agent' : ''}`;
      let cached = this.listCache.get(key);
      if (!cached || cached.signature !== folderSignature || Date.now() - cached.at > 15000 || options.refresh) {
        const dir = await fs.opendir(folder);
        const candidates = [];
        let scanned = 0;
        for await (const entry of dir) {
          check(); scanned++;
          if (options.exclude?.(path.join(folder, entry.name),entry.isDirectory())) continue;
          if ((options.hidden || !entry.name.startsWith('.')) && (!filter || entry.name.toLocaleLowerCase().includes(filter))) candidates.push({ name: entry.name, folder: entry.isDirectory() });
          if (scanned % 2000 === 0) { emit({ id, stage: 'reading', scanned }); await sleepTurn(); }
        }
        cached = { signature: folderSignature, at: Date.now(), candidates, sorted: new Map() };
        this.listCache.set(key, cached);
        while (this.listCache.size > 6) this.listCache.delete(this.listCache.keys().next().value);
      }
      check();
      const sortKey = `${sort}:${direction}`;
      let sorted = cached.sorted.get(sortKey);
      if (!sorted) {
        let candidates = cached.candidates;
        if (sort === 'modified' || sort === 'size') {
          let completed = 0;
          candidates = (await mapLimit(candidates, 24, async e => {
            check();
            try {
              const stat = await fs.lstat(path.join(folder, e.name));
              if (++completed % 2000 === 0) emit({ id, stage: 'metadata', scanned: completed, total: cached.candidates.length });
              return { ...e, size: stat.size, modified: stat.mtimeMs };
            } catch (error) { if (['CANCELLED','PERMISSION_DENIED','POLICY_CHANGED'].includes(error.code)) throw error; return null; }
          })).filter(Boolean);
        }
        check(); emit({ id, stage: 'sorting', scanned: candidates.length, total: candidates.length });
        await sleepTurn();
        sorted = [...candidates].sort((a, b) => Number(b.folder) - Number(a.folder) || direction * ((sort === 'size' || sort === 'modified')
          ? (a[sort] - b[sort]) || collator.compare(a.name, b.name)
          : sort === 'type' ? collator.compare(path.extname(a.name), path.extname(b.name)) || collator.compare(a.name, b.name)
            : collator.compare(a.name, b.name)));
        cached.sorted.set(sortKey, sorted);
      }
      check();
      const entries = (await mapLimit(sorted.slice(offset, offset + limit), 24, async e => {
        check(); try { const file=path.join(folder,e.name);if(options.allowEntry&&!await options.allowEntry(file))return null;return await this.entry(file); } catch(error) {if(['PERMISSION_DENIED','POLICY_CHANGED'].includes(error.code))throw error;return null;}
      })).filter(Boolean);
      return { path: folder, entries, total: sorted.length, scanned: cached.candidates.length, offset, nextOffset: offset + limit < sorted.length ? offset + limit : null, truncated: false, warning: null };
    } finally { this.listings.delete(id); }
  }

  cancelList(id) { this.listings.get(id)?.abort(); return { cancelled: this.listings.has(id) }; }

  async properties(file) {
    const entry = await this.entry(absolute(file));
    let filesystem = null;
    try { const stat = await fs.statfs(entry.path); filesystem = { available: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize }; } catch { /* Optional on unsupported mounts. */ }
    return { ...entry, filesystem };
  }

  async preview(file) {
    const entry = await this.entry(await this.canonical(file));
    if (entry.type === 'symlink' || entry.type === 'folder' || entry.type === 'special') return { entry, type: 'none' };
    if (entry.type === 'text' || (entry.type === 'file' && entry.size < 512 * 1024)) {
      const handle = await fs.open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || identity(stat) !== entry.identity) fail('File changed; refresh before previewing.', 'CHANGED');
        const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (buffer.subarray(0, bytesRead).includes(0)) return { entry, type: 'none' };
        return { entry, type: 'text', text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: stat.size > bytesRead };
      } finally { await handle.close(); }
    }
    return { entry, type: ['image', 'audio', 'video', 'pdf'].includes(entry.type) ? entry.type : 'none', mime: MIME[entry.extension] };
  }

  async mediaFile(file, expectedIdentity) {
    const resolved = await this.canonical(file);
    const stat = await fs.lstat(resolved);
    const type = kind(resolved, stat);
    if (!['image', 'audio', 'video', 'pdf'].includes(type) || identity(stat) !== expectedIdentity) fail('Preview is no longer available.', 'CHANGED');
    return { path: resolved, size: stat.size, mime: MIME[path.extname(resolved).slice(1).toLowerCase()] };
  }

  async settings() {
    if (!this.stateDir) return { bookmarks: [], preferences: {} };
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.stateDir, 'explorer.json'), 'utf8'));
      return { bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks.slice(0, 40) : [], preferences: data.preferences || {} };
    } catch (error) { if (error.code === 'ENOENT') return { bookmarks: [], preferences: {} }; return { bookmarks: [], preferences: {}, warning: 'Saved explorer settings could not be read.' }; }
  }

  async saveSettings(data) {
    if (!this.stateDir) return;
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks.slice(0, 40).map(item => ({ path: absolute(item.path), label: name(item.label || path.basename(item.path) || 'Filesystem') })) : [];
    const preferences = { view: data.preferences?.view === 'list' ? 'list' : 'grid', density: ['comfortable', 'compact', 'large'].includes(data.preferences?.density) ? data.preferences.density : 'comfortable', hidden: Boolean(data.preferences?.hidden), dualPane: Boolean(data.preferences?.dualPane) };
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.stateDir, `settings-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify({ bookmarks, preferences }), { flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, path.join(this.stateDir, 'explorer.json'));
    return { bookmarks, preferences };
  }

  async places() {
    const places = [{ path: this.home, label: 'Home', icon: 'home' }];
    for (const [folder, icon] of [['Desktop', 'monitor'], ['Documents', 'file'], ['Downloads', 'download'], ['Pictures', 'image'], ['Music', 'music'], ['Videos', 'video']]) {
      const file = path.join(this.home, folder);
      if ((await exists(file))?.isDirectory()) places.push({ path: file, label: folder, icon });
    }
    const mounts = [{ path: '/', label: 'Filesystem', icon: 'drive' }];
    try {
      const lines = (await fs.readFile('/proc/self/mounts', 'utf8')).split('\n');
      const seen = new Set(['/']);
      for (const line of lines) {
        const fields = line.split(' ');
        const mount = (fields[1] || '').replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
        if (!seen.has(mount) && ['/media/', '/mnt/', '/run/media/', `/run/user/${process.getuid?.()}/gvfs`].some(prefix => mount.startsWith(prefix))) {
          seen.add(mount); mounts.push({ path: mount, label: path.basename(mount) || mount, icon: 'drive' });
        }
      }
      // GVFS exposes individual shares as folders under one FUSE mount.
      const gvfs = `/run/user/${process.getuid?.()}/gvfs`;
      try { for (const item of await fs.readdir(gvfs, { withFileTypes: true })) if (item.isDirectory()) mounts.push({ path: path.join(gvfs, item.name), label: item.name.split(',')[0], icon: 'drive' }); } catch { /* No GVFS mounts. */ }
    } catch { /* Non-Linux platforms expose filesystem only. */ }
    return { home: this.home, places, mounts, ...(await this.settings()) };
  }

  startSearch(options, emit) {
    options.guard?.();
    if (this.searches.size >= 2) fail('Cancel an existing search before starting another.', 'BUSY');
    const id = randomUUID();
    const controller = new AbortController();
    this.searches.set(id, controller);
    setImmediate(async () => {
      let visited = 0, found = 0, skipped = 0, limited = false;
      let batch = [];
      const flush = () => { if (batch.length) { emit({ id, entries: batch, visited, found, skipped }); batch = []; } };
      try {
        const scope = await this.directory(options.path || this.home);
        const scopeDevice = (await fs.stat(scope)).dev;
        const query = String(options.query || '').trim().toLocaleLowerCase();
        if (!query || query.length > 1024) fail('Enter a search phrase.');
        const maxResults = Math.max(1, Math.min(Number(options.maxResults) || 2000, 5000));
        const maxVisited = Math.max(1, Math.min(Number(options.maxVisited) || 100000, 200000));
        const started = Date.now();
        const stack = [{ path: scope, depth: 0 }];
        emit({ id, scope, entries: [], visited, found, skipped, started: true });
        while (stack.length && !controller.signal.aborted && !limited) {
          options.guard?.();
          const folder = stack.pop();
          try {
            if (await fs.realpath(folder.path) !== folder.path || (await fs.lstat(folder.path)).dev !== scopeDevice) { skipped++; continue; }
            const dir = await fs.opendir(folder.path);
            for await (const child of dir) {
              if (controller.signal.aborted) break;
              if (!options.hidden && child.name.startsWith('.')) continue;
              const file = path.join(folder.path, child.name);
              options.guard?.(); if (options.exclude?.(file,child.isDirectory())) continue;
              visited++;
              // Never follow symlinks or other mounts during recursive search.
              if (child.isDirectory() && folder.depth < 32) stack.push({ path: file, depth: folder.depth + 1 });
              if (child.name.toLocaleLowerCase().includes(query)) {
                try { if(options.allowEntry&&!await options.allowEntry(file)){skipped++;continue;}batch.push(await this.entry(file)); found++; } catch(error) {if(['PERMISSION_DENIED','POLICY_CHANGED'].includes(error.code))throw error;skipped++;}
              }
              if (batch.length >= 40) flush();
              if (found >= maxResults || visited >= maxVisited || Date.now() - started > 30000) { limited = true; break; }
              if (visited % 200 === 0) { flush(); emit({ id, entries: [], visited, found, skipped }); await sleepTurn(); }
            }
          } catch (error) { if (['PERMISSION_DENIED','POLICY_CHANGED'].includes(error.code)) throw error; skipped++; }
        }
        flush();
        emit({ id, entries: [], done: true, cancelled: controller.signal.aborted, limited, visited, found, skipped });
      } catch (error) { emit({ id, entries: [], done: true, error: describeError(error), visited, found, skipped }); }
      finally { this.searches.delete(id); }
    });
    return { id };
  }

  cancelSearch(id) { this.searches.get(id)?.abort(); return { cancelled: this.searches.has(id) }; }
  cancelAll() { for (const controller of [...this.searches.values(), ...this.listings.values()]) controller.abort(); this.archives.cancelAll(); }

  async parentGuard(file) {
    const parent = path.dirname(file);
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('The destination parent changed.', 'CHANGED');
    return { path: parent, dev: stat.dev, ino: stat.ino };
  }
  async assertParent(guard) {
    const stat = await fs.lstat(guard.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== guard.dev || stat.ino !== guard.ino || await fs.realpath(guard.path) !== guard.path) fail('Folder changed during the operation. Refresh and retry.', 'CHANGED');
  }
  async assertEntry(file, signature) {
    const stat = await fs.lstat(file);
    if (identity(stat) !== signature) fail('A source file changed during the operation; its original was preserved.', 'CHANGED');
    return stat;
  }

  // Exclusive creation at every destination leaf: no operation overwrites an existing entry.
  async copyTree(source, destination, context = { count: 0, manifest: [] }, expectedIdentity = null) {
    context.policyGuard?.();
    if (++context.count > this.limits.copyEntries) fail('Operation exceeds the entry limit; split it into smaller selections.', 'LIMIT');
    if (context.count % 100 === 0) this.operationProgress?.({ stage: 'copying', entries: context.count, source, destination });
    const stat = await fs.lstat(source);
    const signature = identity(stat);
    if (expectedIdentity && signature !== expectedIdentity) fail('Source changed after planning; original preserved.', 'CHANGED');
    const sourceParent = await this.parentGuard(source);
    const destinationParent = await this.parentGuard(destination);
    await this.assertParent(sourceParent); await this.assertParent(destinationParent);
    if (stat.isDirectory()) {
      context.policyGuard?.();
      await fs.mkdir(destination, { mode: 0o700 });
      context.manifest.push({ source, destination, signature, directory: true });
      const dir = await fs.opendir(source);
      for await (const child of dir) await this.copyTree(path.join(source, child.name), path.join(destination, child.name), context);
      await this.assertEntry(source, signature);
      context.policyGuard?.();
      await fs.chmod(destination, stat.mode & 0o777);
    } else if (stat.isSymbolicLink()) {
      const target = await fs.readlink(source);
      await this.assertEntry(source, signature);
      context.policyGuard?.();
      await fs.symlink(target, destination);
      context.manifest.push({ source, destination, signature, directory: false });
    } else if (stat.isFile()) {
      context.policyGuard?.();const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let output;
      try {
        if (identity(await input.stat()) !== signature) fail('Source file changed before copying.', 'CHANGED');
        context.policyGuard?.();
        output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, stat.mode & 0o777);
        context.manifest.push({ source, destination, signature, directory: false });
        // Explicit bounded reads/writes avoid FileHandle stream completion waiting on an intentionally-open descriptor.
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0, chunks = 0;
        while (true) {
          context.policyGuard?.();
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          let written = 0;
          while (written < bytesRead) {
            context.policyGuard?.();
            const result = await output.write(buffer, written, bytesRead - written, position + written);
            if (!result.bytesWritten) fail('Could not finish writing the destination.', 'IO');
            written += result.bytesWritten;
          }
          position += bytesRead;
          if (++chunks % 16 === 0) await sleepTurn();
        }
        await output.sync();
        context.policyGuard?.();
        await output.chmod(stat.mode & 0o777);
        if (identity(await input.stat()) !== signature) fail('Source changed while copying. Original preserved; review partial copy.', 'CHANGED');
        await this.assertEntry(source, signature);
        context.policyGuard?.();
        await fs.utimes(destination, stat.atime, stat.mtime);
      } finally { await input.close(); if (output) await output.close(); }
    } else fail('Special device/socket files are not supported by copy or move.', 'UNSUPPORTED');
    await this.assertParent(sourceParent); await this.assertParent(destinationParent);
    return context;
  }

  async removeVerified(manifest, side = 'source', policyGuard) {
    policyGuard?.();
    // First validate the whole tree, then remove only entries still matching their snapshot.
    for (const item of manifest){policyGuard?.();await this.assertEntry(item[side], side === 'source' ? item.signature : item.destinationSignature);}
    for (const item of [...manifest].reverse()) {
      const target = item[side];
      await this.assertParent(await this.parentGuard(target));
      if (item.directory) {
        // Descendant removals change directory timestamps; identity and empty-only rmdir protect additions.
        const stat = await fs.lstat(target);
        const expected = (side === 'source' ? item.signature : item.destinationSignature).split(':');
        if (!stat.isDirectory() || String(stat.dev) !== expected[0] || String(stat.ino) !== expected[1]) fail('Folder changed; remaining source entries were preserved.', 'CHANGED');
        policyGuard?.();
        await fs.rmdir(target);
      } else {
        await this.assertEntry(target, side === 'source' ? item.signature : item.destinationSignature);
        policyGuard?.();
        await fs.unlink(target);
      }
    }
  }

  async transfer(source, destination, mode, expectedIdentity = null, policyGuard) {
    policyGuard?.();
    source = await this.canonical(source);
    destination = path.join(await this.directory(path.dirname(absolute(destination))), name(path.basename(destination)));
    this.protect(source); this.protect(destination);
    if (source === destination) fail('Source and destination are the same.', 'SAME_PATH');
    const sourceStat = await fs.lstat(source);
    if (expectedIdentity && identity(sourceStat) !== expectedIdentity) fail('Source changed after planning; original preserved.', 'CHANGED');
    if (!sourceStat.isFile() && !sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) fail('Special files cannot be transferred.', 'UNSUPPORTED');
    if (sourceStat.isDirectory() && inside(source, destination)) fail('A folder cannot be placed inside itself.', 'SELF_MOVE');
    if (await exists(destination)) fail(`“${path.basename(destination)}” already exists. No files were overwritten.`, 'EXISTS');
    if (mode === 'move') {
      const moved = await this.tryNativeMove(source, destination, expectedIdentity,policyGuard);
      if (moved) return { source, destination, mode, manifest: moved, native: true };
    }
    const context = { count: 0, manifest: [],policyGuard };
    try {
      if (expectedIdentity) await this.assertEntry(source, expectedIdentity);
      await this.copyTree(source, destination, context, expectedIdentity);
      // Capture destination signatures only after the full tree is complete.
      for (const item of context.manifest) item.destinationSignature = identity(await fs.lstat(item.destination));
      if (mode === 'move') await this.removeVerified(context.manifest,'source',policyGuard);
      return { source, destination, manifest: context.manifest, mode };
    } catch (error) {
      // A partial destination is useful recovery evidence, never silently recursively deleted.
      error.partial = { source, destination, created: context.manifest.map(item => item.destination), message: 'Original or remaining source preserved; a partial destination may exist. Inspect both paths before retrying.' };
      throw error;
    }
  }

  async tryNativeMove(source, destination, expectedIdentity = null, policyGuard) {
    policyGuard?.();
    if (!this.nativeMoves) return null;
    const before = await fs.lstat(source);
    if (expectedIdentity && identity(before) !== expectedIdentity) fail('Source changed after planning; original preserved.', 'CHANGED');
    if (!before.isFile() && !before.isDirectory() && !before.isSymbolicLink()) fail('Special files cannot be transferred.', 'UNSUPPORTED');
    const sourceParent = await this.parentGuard(source), destinationParent = await this.parentGuard(destination);
    if (before.dev !== destinationParent.dev) return null;
    await this.assertParent(sourceParent); await this.assertParent(destinationParent);
    await this.assertEntry(source, identity(before));
    policyGuard?.();
    let executionError = null;
    try {
      // Fixed executable and arguments, no shell. GNU mv uses the kernel's no-replace rename on Linux.
      // --no-copy prevents an implicit cross-device fallback that could bypass our verified-copy policy.
      await execFileAsync('/usr/bin/mv', ['--no-copy', '--no-clobber', '--no-target-directory', '--', source, destination], { timeout: 30000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
    } catch (error) { executionError = error; }
    const after = await exists(destination), remaining = await exists(source);
    const moved = after && after.dev === before.dev && after.ino === before.ino && !(remaining && remaining.dev === before.dev && remaining.ino === before.ino);
    if (moved) {
      await this.assertParent(sourceParent); await this.assertParent(destinationParent);
      this.operationProgress?.({ stage: 'moved', entries: 1, source, destination });
      return [{ source, destination, signature: identity(before), destinationSignature: identity(after), directory: after.isDirectory(), native: true }];
    }
    if (after) fail(`“${path.basename(destination)}” already exists or changed. No destination was overwritten.`, 'EXISTS');
    if (executionError?.code === 'ENOENT') return null;
    if (/cross-device|inter-device/i.test(executionError?.stderr || '')) return null;
    fail(executionError?.stderr?.trim() || 'The native move could not be verified; source remains in place.', 'MOVE_FAILED');
  }

  async uniqueDestination(source, folder) {
    const original = path.basename(source);
    const stat = await fs.lstat(source);
    const ext = stat.isDirectory() ? '' : path.extname(original);
    const base = ext ? original.slice(0, -ext.length) : original;
    for (let n = 1; n <= 10000; n++) {
      const destination = path.join(folder, `${base} copy${n === 1 ? '' : ` ${n}`}${ext}`);
      if (!await exists(destination)) return destination;
    }
    fail('Could not find an unused duplicate name.', 'EXISTS');
  }

  serialize(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async mutate(request = {}, emit = () => {}) {
    return this.serialize(async () => {
      request.policyGuard?.();
      this.operationProgress = emit;
      const action = request.action;
      const changes = [], errors = [], undoItems = [];
      if (action === 'undo') return this.undo(request.policyGuard);
      if (action === 'trash') return this.trash(request);
      if (action === 'restore') return this.restore(request);
      if(action==='edit-text'){
        try{const item=await this.textEdits.apply(request);if(item.changed){this.history.push({id:randomUUID(),action,items:[{type:'edit-text',...item}],at:Date.now()});changes.push({source:item.target,destination:item.target,bytes:item.edited.length});}}
        catch(error){if(error.editUndo)this.history.push({id:randomUUID(),action,items:[{type:'edit-text',...error.editUndo}],at:Date.now()});errors.push({path:request.paths?.[0],...describeError(error),partial:error.partial||null});}
        this.history=this.history.slice(-20);return{action,changes,errors,partial:errors.length>0,undoAvailable:this.history.length>0};
      }
      if (['archive-create', 'archive-extract'].includes(action)) {
        for(const source of request.paths||[])await request.sourceGuard?.(source);
        request.policyGuard?.();
        const result = await this.archives.run(request);
        if (result.undoItem) this.history.push({ id: randomUUID(), action, items: [result.undoItem], at: Date.now() });
        this.history = this.history.slice(-20);
        return { action, changes: result.changes, errors: result.errors, partial: result.errors.length > 0, undoAvailable: this.history.length > 0 };
      }
      if (['new-folder', 'new-file'].includes(action)) {
        request.policyGuard?.();
        const folder = await this.directory(request.destination);
        const target = path.join(folder, name(request.name)); this.protect(target);
        const guard = await this.parentGuard(target); await this.assertParent(guard);
        request.policyGuard?.();
        if (action === 'new-folder') await fs.mkdir(target, { mode: 0o755 });
        else await fs.writeFile(target, '', { flag: 'wx', mode: 0o644 });
        await this.assertParent(guard);
        changes.push({ destination: target });
        undoItems.push({ type: 'create', target, signature: identity(await fs.lstat(target)), directory: action === 'new-folder' });
      } else {
        if (!['copy', 'move', 'rename', 'duplicate', 'batch-rename'].includes(action)) fail('Unsupported file action.');
        const sources = Array.isArray(request.paths) ? request.paths : request.path ? [request.path] : [];
        if (!sources.length || sources.length > 500) fail('Select between 1 and 500 entries.');
        const canonical = await Promise.all(sources.map(file => this.canonical(file)));
        for(const source of canonical)await request.sourceGuard?.(source);
        request.policyGuard?.();
        if (new Set(canonical).size !== canonical.length) fail('The selection contains duplicate entries.');
        for (const source of canonical) if (canonical.some(other => other !== source && inside(other, source))) fail('Select a folder or its contents, not both.');
        if (request.expectedIdentities) for (const source of canonical) {
          if (request.expectedIdentities[source] !== identity(await fs.lstat(source))) fail('Source changed; refresh the selection and retry.', 'CHANGED');
        }
        const folder = ['copy', 'move'].includes(action) ? await this.directory(request.destination) : null;
        let batchNames = null;
        if (action === 'batch-rename') {
          const prefix = name(request.prefix || 'File');
          const start = Math.max(0, Math.min(Number.isFinite(Number(request.start)) && request.start !== null && request.start !== undefined ? Number(request.start) : 1, 999999));
          batchNames = await Promise.all(canonical.map(async (source, index) => `${prefix}${String(start + index).padStart(3, '0')}${request.keepExtension === false || (await fs.lstat(source)).isDirectory() ? '' : path.extname(source)}`));
          for (let i = 0; i < canonical.length; i++) {
            const target = path.join(path.dirname(canonical[i]), name(batchNames[i]));
            if (target !== canonical[i] && await exists(target)) fail(`Batch rename conflicts with “${path.basename(target)}”; nothing was changed.`, 'EXISTS');
          }
        }
        for (let index = 0; index < canonical.length; index++) {
          const source = canonical[index];
          try {
            request.policyGuard?.();
            await request.sourceGuard?.(source);
            let destination;
            if (action === 'duplicate') destination = Array.isArray(request.exactTargets) && request.exactTargets.length === canonical.length
              ? path.join(await this.directory(path.dirname(absolute(request.exactTargets[index]))), name(path.basename(request.exactTargets[index])))
              : await this.uniqueDestination(source, path.dirname(source));
            else if (action === 'rename') {
              if (canonical.length !== 1) fail('Rename one entry at a time.');
              destination = path.join(path.dirname(source), name(request.name));
            } else if (action === 'batch-rename') destination = path.join(path.dirname(source), batchNames[index]);
            else destination = path.join(folder, path.basename(source));
            if (source === destination && ['rename', 'batch-rename'].includes(action)) continue;
            const mode = ['move', 'rename', 'batch-rename'].includes(action) ? 'move' : 'copy';
            request.policyGuard?.();const change = await this.transfer(source, destination, mode, request.expectedIdentities?.[source],request.policyGuard);
            changes.push({ source, destination }); undoItems.push({ type: 'transfer', ...change });
          } catch (error) { errors.push({ path: source, ...describeError(error), partial: error.partial || null }); }
        }
      }
      if (undoItems.length) this.history.push({ id: randomUUID(), action, items: undoItems, at: Date.now() });
      this.history = this.history.slice(-20);
      return { action, changes, errors, partial: errors.length > 0, undoAvailable: this.history.length > 0 };
    });
  }

  async undo(policyGuard) {
    policyGuard?.();
    const operation = this.history.at(-1);
    if (!operation) fail('There is no operation to undo.', 'EMPTY');
    const changes = [], errors = [], remaining = [];
    for (const item of [...operation.items].reverse()) {
      try {
        policyGuard?.(operation.action);
        if(item.type==='edit-text'){
          const restored=await this.textEdits.undo(item,policyGuard?()=>policyGuard(operation.action):undefined);changes.push({source:restored.target,destination:restored.target,bytes:restored.edited.length});
        } else if (item.type === 'create') {
          await this.assertEntry(item.target, item.signature);
          policyGuard?.(operation.action);
          if (item.directory) await fs.rmdir(item.target); else await fs.unlink(item.target);
          changes.push({ source: item.target });
        } else if (item.mode === 'move') {
          for (const part of item.manifest) await this.assertEntry(part.destination, part.destinationSignature);
          const change = await this.transfer(item.destination, item.source, 'move',null,policyGuard?()=>policyGuard(operation.action):undefined);
          changes.push({ source: change.source, destination: change.destination });
        } else {
          await this.removeVerified(item.manifest, 'destination',policyGuard?()=>policyGuard(operation.action):undefined);
          changes.push({ source: item.destination });
        }
      } catch (error) { remaining.push(item.type==='edit-text'&&error.editUndo?{...item,signature:error.editUndo.signature,edited:error.editUndo.edited}:item); errors.push({ path: item.target || item.destination, ...describeError(error), partial: error.partial || null }); }
    }
    this.history.pop();
    if (remaining.length) this.history.push({ ...operation, items: remaining.reverse() });
    return { action: 'undo', changes, errors, partial: errors.length > 0, undoAvailable: this.history.length > 0 };
  }

  async privateDirectory(file) {
    try { await fs.mkdir(file, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) fail('Trash directory ownership or permissions are unsafe.', 'UNSAFE_TRASH');
  }

  async trashLocation(source) {
    let root, mount = null;
    if (this.trashOverride) root = this.trashOverride;
    else {
      const sourceStat = await fs.lstat(source);
      const homeStat = await fs.stat(this.home);
      if (sourceStat.dev === homeStat.dev) root = path.join(process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(this.home, '.local', 'share'), 'Trash');
      else {
        mount = path.dirname(source);
        while (mount !== '/') {
          const parent = path.dirname(mount);
          if ((await fs.stat(parent)).dev !== sourceStat.dev) break;
          mount = parent;
        }
        const shared = path.join(mount, '.Trash');
        const sharedStat = await exists(shared);
        root = sharedStat?.isDirectory() && !sharedStat.isSymbolicLink() && (sharedStat.mode & 0o1000)
          ? path.join(shared, String(process.getuid())) : path.join(mount, `.Trash-${process.getuid()}`);
      }
    }
    // Only the data-home parent is created recursively; Trash itself must be private and non-symlink.
    if (!mount) await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    await this.privateDirectory(root);
    await this.privateDirectory(path.join(root, 'files'));
    await this.privateDirectory(path.join(root, 'info'));
    this.trashRoots.add(root);
    return { root, mount };
  }

  async prepareTrash(paths, expectedIdentities = null) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 500) fail('Select between 1 and 500 entries.');
    const entries = [];
    for (const file of paths) {
      const source = await this.canonical(file); this.protect(source);
      const entry = await this.entry(source);
      if (expectedIdentities && entry.identity !== expectedIdentities[source]) fail('Source changed after planning; nothing was confirmed.', 'CHANGED');
      entries.push(entry);
    }
    const seen = new Set(entries.map(e => e.path));
    if (seen.size !== entries.length || entries.some(e => entries.some(other => e.path !== other.path && inside(other.path, e.path)))) fail('Select a folder or its contents, not both.');
    const token = randomUUID();
    this.confirmations.set(token, { entries, expires: Date.now() + 60000 });
    for (const [key, value] of this.confirmations) if (value.expires < Date.now()) this.confirmations.delete(key);
    return { token, entries: entries.map(e => ({ path: e.path, name: e.name, type: e.type })), expires: Date.now() + 60000 };
  }

  async trash(request) {
    const confirmation = this.confirmations.get(request.token);
    this.confirmations.delete(request.token);
    if (!confirmation || confirmation.expires < Date.now() || request.confirmed !== true) fail('Confirm the current selection before moving it to Trash.', 'CONFIRMATION');
    const changes = [], errors = [];
    for (const entry of confirmation.entries) {
      let infoPath, destination;
      try {
        request.policyGuard?.();
        const source = await this.canonical(entry.path); this.protect(source);
        await request.sourceGuard?.(source);
        await this.assertEntry(source, entry.identity);
        const { root, mount } = await this.trashLocation(source);
        const id = `${path.basename(source).replace(/[/\\\r\n]/g, '_').slice(0, 32)}-${randomUUID()}`;
        infoPath = path.join(root, 'info', `${id}.trashinfo`); destination = path.join(root, 'files', id);
        const original = mount ? path.relative(mount, source) : source;
        const now = new Date();
        const pad = value => String(value).padStart(2, '0');
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        request.policyGuard?.();
        await fs.writeFile(infoPath, `[Trash Info]\nPath=${encodeURIComponent(original).replace(/%2F/g, '/')}\nDeletionDate=${date}\n`, { flag: 'wx', mode: 0o600 });
        // Trash root is deliberately protected from ordinary transfers. Use the same exclusive primitive here.
        const native = await this.tryNativeMove(source, destination,null,request.policyGuard);
        if (!native) {
          const context = await this.copyTree(source, destination,{count:0,manifest:[],policyGuard:request.policyGuard});
          for (const item of context.manifest) item.destinationSignature = identity(await fs.lstat(item.destination));
          await this.removeVerified(context.manifest,'source',request.policyGuard);
        }
        changes.push({ source, destination, trashId: id, trashRoot: root });
      } catch (error) {
        if (infoPath && !await exists(destination)) await fs.unlink(infoPath).catch(() => {});
        errors.push({ path: entry.path, ...describeError(error), partial: destination && await exists(destination) ? { destination, message: 'A recoverable Trash copy and metadata exist; original or remaining source may also exist.' } : null });
      }
    }
    return { action: 'trash', changes, errors, partial: errors.length > 0, undoAvailable: this.history.length > 0 };
  }

  async listTrash() {
    const { root } = await this.trashLocation(this.home);
    if (!this.trashOverride) {
      const uid = String(process.getuid?.());
      for (const mount of (await this.places()).mounts) {
        for (const candidate of [path.join(mount.path, '.Trash', uid), path.join(mount.path, `.Trash-${uid}`)]) {
          try {
            const stat = await fs.lstat(candidate);
            if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === Number(uid) && !(stat.mode & 0o077)) {
              const parent = await fs.lstat(path.dirname(candidate));
              if (path.basename(path.dirname(candidate)) === '.Trash' && (!parent.isDirectory() || parent.isSymbolicLink() || !(parent.mode & 0o1000))) continue;
              await this.privateDirectory(path.join(candidate, 'files')); await this.privateDirectory(path.join(candidate, 'info'));
              this.trashRoots.add(candidate);
            }
          } catch { /* Missing, inaccessible, or unsafe mount Trash stays untouched. */ }
        }
      }
    }
    const roots = [...new Set([root, ...this.trashRoots])];
    const entries = [], errors = [];
    for (const trashRoot of roots) {
      try {
        const names = await fs.readdir(path.join(trashRoot, 'info'));
        for (const infoName of names) {
          if (!infoName.endsWith('.trashinfo')) continue;
          const id = infoName.slice(0, -10);
          try {
            const data = await this.readTrashInfo(trashRoot, id);
            const entry = await this.entry(path.join(trashRoot, 'files', id));
            entries.push({ ...entry, name: path.basename(data.original), originalPath: data.original, deleted: data.deleted, trashId: id, trashRoot });
          } catch (error) { errors.push({ path: infoName, ...describeError(error) }); }
        }
      } catch (error) { errors.push({ path: trashRoot, ...describeError(error) }); }
    }
    entries.sort((a, b) => String(b.deleted).localeCompare(String(a.deleted)));
    return { entries, errors, total: entries.length, path: 'trash:' };
  }

  async readTrashInfo(root, id) {
    if (!this.trashRoots.has(root)) fail('Unknown Trash location.');
    name(id);
    const file = path.join(root, 'info', `${id}.trashinfo`);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text;
    try { const info = await handle.stat(); if (!info.isFile() || info.size > 16384) fail('Invalid Trash metadata.'); text = await handle.readFile('utf8'); } finally { await handle.close(); }
    const encoded = /^Path=([^\r\n]*)/m.exec(text)?.[1];
    if (!text.startsWith('[Trash Info]') || !encoded) fail('Invalid Trash metadata.');
    const decoded = decodeURIComponent(encoded);
    const isHome = this.trashOverride === root || path.basename(root) === 'Trash';
    const original = isHome ? absolute(decoded) : path.resolve(path.dirname(path.basename(root) === String(process.getuid?.()) ? path.dirname(root) : root), decoded);
    if (!isHome) {
      const mount = path.basename(root) === String(process.getuid?.()) ? path.dirname(path.dirname(root)) : path.dirname(root);
      if (path.isAbsolute(decoded) || !inside(mount, original)) fail('Trash metadata escapes its mount.', 'INVALID');
    }
    return { original, deleted: /^DeletionDate=([^\r\n]*)/m.exec(text)?.[1] || '' };
  }

  async restore(request) {
    const items = Array.isArray(request.items) ? request.items : [];
    if (!items.length || items.length > 500) fail('Choose between 1 and 500 entries to restore.');
    const changes = [], errors = [];
    for (const item of items) {
      try {
        request.policyGuard?.();
        const root = absolute(item.trashRoot); const id = name(item.trashId);
        const data = await this.readTrashInfo(root, id);
        const source = path.join(root, 'files', id);
        const destination = await this.canonical(data.original); this.protect(destination);
        if (await exists(destination)) fail('The original name is occupied; nothing was overwritten. Rename the existing entry before restoring.', 'EXISTS');
        const native = await this.tryNativeMove(source, destination,null,request.policyGuard);
        if (!native) {
          const context = await this.copyTree(source, destination,{count:0,manifest:[],policyGuard:request.policyGuard});
          for (const part of context.manifest) part.destinationSignature = identity(await fs.lstat(part.destination));
          await this.removeVerified(context.manifest,'source',request.policyGuard);
        }
        await fs.unlink(path.join(root, 'info', `${id}.trashinfo`));
        changes.push({ source, destination });
      } catch (error) { errors.push({ path: item.trashId, ...describeError(error) }); }
    }
    return { action: 'restore', changes, errors, partial: errors.length > 0, undoAvailable: this.history.length > 0 };
  }
}

module.exports = { FilesystemService, absolute, name, inside, identity, kind, describeError, MIME };
