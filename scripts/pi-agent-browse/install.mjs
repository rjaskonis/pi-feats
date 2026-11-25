import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../../assets/pi-agent-browse/', import.meta.url));
const root = join(homedir(), 'pi-feats', 'browse');
const marker = '.pi-feats-managed.json';

function files(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name);
    const key = `${prefix}${name}`;
    const stat = lstatSync(path);
    if (stat.isDirectory()) return files(path, `${key}/`);
    if (!stat.isFile()) throw new Error(`Unexpected entry: ${path}`);
    return [[key, stat.mode & 0o111, createHash('sha256').update(readFileSync(path)).digest('hex')]];
  });
}

function matches(directory, expected) {
  try {
    if (!lstatSync(directory).isDirectory()) return false;
    const actual = files(directory).filter(([name]) => name !== marker);
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function synchronize(name, source) {
  const destination = join(root, name);
  const expected = files(source);
  const installed = existsSync(destination);
  if (installed && (!lstatSync(destination).isDirectory() || !existsSync(join(destination, marker)))) {
    throw new Error(`Refusing to replace an unmanaged directory: ${destination}`);
  }
  if (installed && matches(destination, expected)) return false;
  const workspace = mkdtempSync(join(root, `.${name}-`));
  const staged = join(workspace, 'new');
  const previous = join(workspace, 'old');
  try {
    cpSync(source, staged, { recursive: true, errorOnExist: true });
    writeFileSync(join(staged, marker), JSON.stringify(expected) + '\n');
    if (!matches(staged, expected)) throw new Error(`Copy verification failed for ${name}`);
    if (installed) renameSync(destination, previous);
    try {
      renameSync(staged, destination);
    } catch (error) {
      if (installed) renameSync(previous, destination);
      throw error;
    }
  } finally {
    // Keep the backup if rollback itself failed.
    if (existsSync(destination) || !existsSync(previous)) rmSync(workspace, { recursive: true, force: true });
  }
  return true;
}

if (existsSync(assets)) {
  const extension = join(assets, 'extension');
  const relay = join(assets, `relay-${process.platform}-${process.arch}`);
  if (!existsSync(join(extension, 'manifest.json'))) throw new Error('Missing bundled Pi Agent Browse extension');
  if (!existsSync(join(relay, 'pi-agent-browse-relay'))) {
    console.warn(`Pi Agent Browse: this private build does not include a relay for ${process.platform}-${process.arch}.`);
  } else {
    mkdirSync(root, { recursive: true });
    const extensionChanged = synchronize('extension', extension);
    const relayChanged = synchronize('relay', relay);
    const executable = join(root, 'relay', 'pi-agent-browse');
    if (relayChanged) {
      // Use the relay's authenticated shutdown, if one is running. First installs do not start a listener.
      const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
      const state = join(stateHome, 'pi-agent-browse', 'relays', '20087', 'relay.json');
      if (existsSync(state)) {
        const result = spawnSync(executable, ['restart'], { stdio: 'inherit', timeout: 45_000 });
        if (result.error || result.status !== 0) console.warn(`Pi Agent Browse: run ${executable} restart to activate the new relay.`);
      }
    }
    console.log(`Pi Agent Browse ${extensionChanged || relayChanged ? 'installed or updated' : 'already up to date'}.`);
    console.log(`Chrome Load unpacked: ${join(root, 'extension')}`);
    console.log(`Pairing command: ${executable} pair`);
    if (extensionChanged) console.log('If already loaded, reload the extension in chrome://extensions.');
  }
}
