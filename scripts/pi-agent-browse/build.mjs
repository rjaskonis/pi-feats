import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brand, extensionId, upstream } from './brand.mjs';

const [checkoutArg, outputArg, mode, ...extra] = process.argv.slice(2);
if (!checkoutArg || !outputArg || (mode && mode !== '--extension-only') || extra.length || process.platform === 'win32') {
  console.error('Usage (Linux or macOS): node scripts/pi-agent-browse/build.mjs <browse-checkout> <new-output-directory> [--extension-only]');
  process.exit(2);
}
const checkout = resolve(checkoutArg);
const output = resolve(outputArg);
if (existsSync(output)) throw new Error('Choose an output directory that does not exist');
const source = mkdtempSync(join(tmpdir(), 'pi-agent-browse-build-'));
const here = fileURLToPath(new URL('.', import.meta.url));
const run = (command, args, cwd = source, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
};
try {
  // Export tracked files from the pinned revision; never use the checkout's uncommitted state.
  const archive = join(source, 'upstream.tar');
  execFileSync('git', ['-C', checkout, 'archive', '-o', archive, upstream]);
  run('tar', ['-xf', archive]);
  rmSync(archive);
  brand(source);
  const icon = join(source, 'public/icons/logo.svg');
  writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="4" width="120" height="120" rx="25" fill="#153f46"/><path d="M26 47h76v12H87v35H74V59H54v35H41V59H26z" fill="#9af5d0"/></svg>\n');
  for (const size of [16, 32, 48, 128]) {
    run(process.env.IMAGEMAGICK || 'convert', [icon, '-resize', `${size}x${size}`, join(source, `public/icons/icon-${size}.png`)]);
  }
  run('bun', ['install', '--frozen-lockfile', '--ignore-scripts']);
  run('bun', ['run', 'build']);
  const extension = join(source, 'dist');
  copyFileSync(join(source, 'LICENSE'), join(extension, 'LICENSE'));
  mkdirSync(output, { recursive: true });
  const extensionZip = join(output, 'pi-agent-browse-extension.zip');
  run('zip', ['-qr', extensionZip, '.'], extension);
  const artifacts = [extensionZip];
  if (mode !== '--extension-only') {
    const cargoTarget = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(source, 'rust/target');
    run(process.env.CARGO || 'cargo', ['build', '--locked', '--release', '-p', 'browse'], join(source, 'rust'), { ...process.env, CARGO_TARGET_DIR: cargoTarget });
    const relay = join(source, 'relay-package');
    mkdirSync(relay);
    copyFileSync(join(cargoTarget, 'release/browse'), join(relay, 'pi-agent-browse-relay'));
    copyFileSync(join(here, 'pi-agent-browse.sh'), join(relay, 'pi-agent-browse'));
    copyFileSync(join(source, 'LICENSE'), join(relay, 'LICENSE'));
    chmodSync(join(relay, 'pi-agent-browse'), 0o755);
    chmodSync(join(relay, 'pi-agent-browse-relay'), 0o755);
    const relayZip = join(output, `pi-agent-browse-relay-${process.platform}-${process.arch}.zip`);
    run('zip', ['-qr', relayZip, '.'], relay);
    artifacts.push(relayZip);
  }
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  writeFileSync(join(output, 'SHA256SUMS'), artifacts.map(file => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(file)}`).join('\n') + '\n');
  writeFileSync(join(output, 'BUILD.txt'), `Upstream: ${upstream}\nChrome extension ID: ${extensionId}\n`);
  console.log(`Browse artifacts are ready in ${output}`);
} finally {
  rmSync(source, { recursive: true, force: true });
}
