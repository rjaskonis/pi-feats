import { dirname, join } from 'node:path';
import { createJiti } from 'jiti';
const root = process.argv[2], cli = process.argv[3];
process.argv[1] = cli;
Object.assign(process.env, { PI_CODING_AGENT_DIR: root, PI_PROFILE_ROOT: root, PI_API_WORKER: '1', PI_OFFLINE: '1' });
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { '@earendil-works/pi-coding-agent': join(dirname(cli), 'index.js') } });
try {
  const { startApiServer } = await jiti.import('../../extensions/api-server/server.ts');
  const server = await startApiServer({ agentDir: root, cwd: root });
  process.send?.({ port: server.server.address().port });
  process.on('message', async (message) => { if (message === 'close') { await server.close(); process.exit(0); } });
} catch (error) { console.error(error); process.exit(1); }
