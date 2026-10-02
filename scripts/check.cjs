const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? files(join(dir, e.name)) : /\.(?:js|cjs)$/.test(e.name) ? [join(dir, e.name)] : []);
}
let failed = false;
for (const file of [...files('src'), ...files('test'), ...files('scripts'), 'scripts/start']) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
