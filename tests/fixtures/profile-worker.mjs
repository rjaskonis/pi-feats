import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const frame = (value) => process.stdout.write('PI_OPENAI_EVENT:' + JSON.stringify(value) + '\n');
let request, waiting = false;
const finish = (text) => {
  frame({ type: 'text', delta: text });
  frame({ type: 'result', result: { text, finishReason: 'stop', usage: { input: 1, output: 1, cached: 0, reasoning: 0 }, ...(waiting ? { calls: [], pending: false } : {}) } });
  waiting = false;
  frame({ type: 'idle' });
};
input.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.type === 'resume' && waiting) { frame({ type: 'ready' }); finish('resumed:' + process.pid); return; }
  if (message.type !== 'execute') process.exit(2);
  request = message.job.request;
  frame({ type: 'ready' });
  const text = request.messages.at(-1).content;
  if (text === 'crash') { process.stderr.write('secret-provider-key\n'); process.exit(2); }
  if (text === 'provider-usage-failure') { frame({ type: 'failure', code: 'provider_usage_limit_exceeded', message: 'PRIVATE_TOKEN_MARKER' }); frame({ type: 'idle' }); return; }
  if (text === 'provider-auth-failure') { frame({ type: 'failure', code: 'provider_authentication_failed', message: 'PRIVATE_TOKEN_MARKER' }); frame({ type: 'idle' }); return; }
  if (text === 'hang') return;
  if (message.job.client) {
    waiting = true;
    frame({ type: 'yield', text: '', calls: [{ type: 'function_call', id: 'fc_' + 'a'.repeat(32), call_id: 'call_' + 'a'.repeat(32), name: 'view_file', arguments: '{}', status: 'completed' }], usage: { input: 1, output: 1, cached: 0, reasoning: 0 }, finishReason: 'stop', pending: true }); return;
  }
  if (text.startsWith('delay:')) await new Promise((resolve) => setTimeout(resolve, Number(text.slice(6))));
  finish(text + ':' + process.pid);
});
