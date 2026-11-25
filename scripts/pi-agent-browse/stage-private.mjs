import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { extensionId } from './brand.mjs';

const releases = process.argv.slice(2).map(arg => resolve(arg));
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.name !== 'pi-feats' || manifest.private !== true || releases.length === 0) {
  throw new Error('Run from a private pi-feats checkout (package.json private: true), with one or more Browse release directories.');
}
const destination = resolve('assets/pi-agent-browse');
if (existsSync(destination)) throw new Error(`Remove the previous bundle first: ${destination}`);
const workspace = mkdtempSync(resolve('assets/.pi-agent-browse-'));
try {
  let extensionHash;
  for (const release of releases) {
    const sums = new Map(readFileSync(join(release, 'SHA256SUMS'), 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/).reverse()));
    const build = readFileSync(join(release, 'BUILD.txt'), 'utf8');
    if (!build.split('\n').includes(`Chrome extension ID: ${extensionId}`)) throw new Error(`Unexpected extension ID in ${release}`);
    const extension = 'pi-agent-browse-extension.zip';
    const relays = readdirSync(release).filter(name => /^pi-agent-browse-relay-(linux|darwin)-(x64|arm64)\.zip$/.test(name));
    if (!relays.length) throw new Error(`No relay archive in ${release}`);
    for (const name of [extension, ...relays]) {
      const archive = join(release, name);
      const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
      if (digest !== sums.get(name)) throw new Error(`Checksum mismatch: ${archive}`);
      if (name === extension && extensionHash !== undefined) continue;
      const target = join(workspace, name === extension ? 'extension' : basename(name, '.zip').slice('pi-agent-browse-'.length));
      mkdirSync(target);
      execFileSync('unzip', ['-q', archive, '-d', target]);
      if (name === extension) {
        extensionHash = digest;
        copyFileSync(archive, join(workspace, extension));
        const chrome = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
        const id = createHash('sha256').update(Buffer.from(chrome.key, 'base64')).digest('hex').slice(0, 32)
          .replace(/./g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
        if (id !== extensionId || chrome.name !== 'Pi Agent Browse') throw new Error('Unexpected extension identity');
      } else {
        copyFileSync(new URL('./pi-agent-browse.sh', import.meta.url), join(target, 'pi-agent-browse'));
        for (const binary of ['pi-agent-browse', 'pi-agent-browse-relay']) chmodSync(join(target, binary), 0o755);
      }
    }
  }
  renameSync(workspace, destination);
  console.log(`Staged Pi Agent Browse in ${destination}. Include these assets only in the private distribution.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
