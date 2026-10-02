'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { identity, absolute, name, inside } = require('./filesystem.cjs');

function stamp(stat) { return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }; }
function error(message, code = 'ARCHIVE') { return Object.assign(new Error(message), { code }); }
class Archives {
  constructor(filesystem, { limits = {}, spawnImpl = spawn } = {}) {
    this.fs = filesystem; this.spawn = spawnImpl; this.children = new Set();
    this.limits = { entries: 100000, bytes: 20 * 1024 ** 3, ratio: 2000, ...limits };
  }
  cancelAll() { for (const child of this.children) child.kill('SIGTERM'); }
  async run(request) {
    const sources = Array.isArray(request.paths) ? request.paths : [];
    if (!sources.length || sources.length > 500 || request.action === 'archive-extract' && sources.length !== 1) throw error('Choose 1–500 archive sources, or one archive to extract.');
    const folder = await this.fs.directory(request.destination);
    const destination = path.join(folder, name(request.name)); this.fs.protect(destination);
    const checkedSources = [];
    for (const file of sources) {
      const checked = await this.fs.canonical(file); this.fs.protect(checked);
      if (checked === destination || inside(checked, destination)) throw error('An archive destination cannot be inside a selected source.');
      const stat = await fs.lstat(checked, { bigint: true });
      if (!stat.isFile() && !stat.isDirectory() || request.action === 'archive-extract' && !stat.isFile()) throw error('Archive sources must be ordinary files/folders; links and special files are excluded.');
      checkedSources.push({ path: checked, stamp: stamp(stat) });
    }
    if (new Set(checkedSources.map(e => e.path)).size !== checkedSources.length || checkedSources.some(e => checkedSources.some(other => other.path !== e.path && inside(other.path, e.path)))) throw error('Select a folder or its contents, not both.');
    const guard = await this.fs.parentGuard(destination); await this.fs.assertParent(guard);
    try { await fs.lstat(destination); throw error('The archive destination already exists. Nothing was overwritten.', 'EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'systemus-archive-')); await fs.chmod(scratch, 0o700);
    const manifestPath = path.join(scratch, 'manifest.json');
    try {
      const payload = { action: request.action, sources: checkedSources, destination, format: request.format || 'zip', manifest: manifestPath, limits: this.limits,agent:typeof request.policyGuard==='function' };
      request.policyGuard?.();
      const result = await this.invoke(payload,request.signal,request.policyGuard);
      await this.fs.assertParent(guard);
      const manifestStat = await fs.stat(manifestPath); if (manifestStat.size > 64 * 1024 * 1024) throw error('Archive undo manifest exceeded its safe bound.');
      const entries = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!Array.isArray(entries) || entries.length > this.limits.entries + 1) throw error('Archive undo manifest is invalid.');
      const manifest = [];
      for (const entry of entries) {
        const file = absolute(entry.path);
        if (!inside(destination, file)) throw error('Archive manifest escaped the destination.');
        const current = await fs.lstat(file, { bigint: true });
        if (JSON.stringify(stamp(current)) !== JSON.stringify(entry.stamp)) throw error('Extracted file changed before acceptance; destination retained for inspection.', 'CHANGED');
        manifest.push({ destination: file, destinationSignature: identity(await fs.lstat(file)), directory: entry.directory });
      }
      return { changes: [{ destination, sources: checkedSources.map(e => e.path), entries: result.entries, bytes: result.bytes }], errors: [], undoItem: request.action === 'archive-create'
        ? { type: 'create', target: destination, signature: identity(await fs.lstat(destination)), directory: false }
        : { type: 'transfer', mode: 'copy', destination, manifest } };
    } catch (e) {
      const partial = await fs.lstat(destination).then(() => true, () => false);
      return { changes: [], errors: [{ path: destination, code: e.code || 'ARCHIVE', message: e.message, partial: partial ? { destination, message: 'Sources remain unchanged; incomplete archive/extraction was retained for recovery and inspection.' } : null }] };
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
  invoke(payload,signal,policyGuard) {
    return new Promise((resolve, reject) => {
      if(signal?.aborted){reject(error('Archive request cancelled; partial output is retained.','CANCELLED'));return;}policyGuard?.();
      const child = this.spawn('/usr/bin/python3', ['-I', '-S', '-B', path.join(__dirname, 'archive_helper.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.children.add(child);
      let result, stderr = '', line = '', total = 0, failure = null; const decoder = new StringDecoder('utf8');
      const cancel=()=>{failure=error('Archive request cancelled; partial output is retained.','CANCELLED');child.kill('SIGKILL');};signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
      const timer = setTimeout(() => { failure = error('Archive operation exceeded 120 seconds; partial output is retained.', 'TIMEOUT'); child.kill('SIGKILL'); }, 120000);
      const parse = value => { try { const event = JSON.parse(value); if (event.type === 'progress') this.fs.operationProgress?.(event); if (event.type === 'result') result = event; } catch { failure = error('Archive helper returned malformed output.'); } };
      child.stdout.on('data', chunk => {
        total += chunk.length; if (total > 2 * 1024 * 1024) { failure = error('Archive helper exceeded its bounded output.'); child.kill('SIGKILL'); return; }
        line += decoder.write(chunk); let end; while ((end = line.indexOf('\n')) >= 0) { parse(line.slice(0, end)); line = line.slice(end + 1); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
      const cleanup = () => { clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.children.delete(child); };
      child.once('error', e => { cleanup(); reject(error(e.code === 'ENOENT' ? 'Python 3.12 is required for archive operations.' : e.message)); });
      child.once('close', code => { cleanup(); line += decoder.end(); if (line.trim()) parse(line); if (failure) reject(failure); else if (code !== 0 || !result?.ok) reject(error(result?.message || stderr || 'Archive helper did not complete.')); else resolve(result); });
    });
  }
}
module.exports = { Archives, stamp };
