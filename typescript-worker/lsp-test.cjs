// End-to-end coverage of the packaged worker and the Rust LSP transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const executable = path.resolve(process.argv[2] || `target/debug/typebreeze${process.platform === 'win32' ? '.exe' : ''}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typebreeze-lsp-'));
fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"module":"ESNext","moduleResolution":"Bundler"}}');
fs.writeFileSync(path.join(root, 'strings.ext.ts'), 'export function upper(value: string) { return value.toUpperCase(); }');
fs.writeFileSync(path.join(root, 'use.ts'), 'const title = "hello"; title.');
const child = spawn(executable, [], { cwd: root, env: { ...process.env, NODE_PATH: path.resolve(__dirname, '../node_modules') }, stdio: ['pipe', 'pipe', 'inherit'] });
const closed = new Promise(resolve => child.once('close', resolve));
let buffer = Buffer.alloc(0), id = 0;
const pending = new Map();
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) break;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) break;
    const response = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size);
    if (pending.has(response.id)) {
      const { resolve, reject, timeout } = pending.get(response.id);
      pending.delete(response.id); clearTimeout(timeout);
      response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result);
    }
  }
});
function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out: ${method}`)); }, 20_000);
    pending.set(requestId, { resolve, reject, timeout }); send({ id: requestId, method, params });
  });
}
(async () => {
  try {
    await request('initialize', { processId: process.pid, capabilities: {}, workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'test' }] });
    send({ method: 'initialized', params: {} });
    const text = 'const title = "hello"; title.';
    const textDocument = { uri: pathToFileURL(path.join(root, 'use.ts')).href };
    send({ method: 'textDocument/didOpen', params: { textDocument: { ...textDocument, languageId: 'typescript', version: 1, text } } });
    const params = { textDocument, position: { line: 0, character: text.length }, text, clientVersion: 1, documents: [] };
    const result = await request('typeBreeze/extensionCompletions', params);
    assert.equal(result.candidates[0].name, 'upper');
    const plan = await request('typeBreeze/extensionCallPlan', { ...params, snapshot: result.snapshot, candidateId: result.candidates[0].id });
    assert.equal(plan.edits[0].newText, 'upper(title)');
    assert.match(plan.edits[1].newText, /import \{ upper \}/);
    assert.equal(await request('typeBreeze/extensionCallPlan', { ...params, snapshot: 'stale', candidateId: result.candidates[0].id }), null);
    const unionText = "type Status = 'draft' | 'live'; const value: Status = 'draft';";
    const union = await request('typeBreeze/resolveLiteral', { textDocument, text: unionText, clientVersion: 2, position: { line: 0, character: unionText.lastIndexOf('draft') + 1 } });
    assert.equal(union.contextualTypeName, 'Status');
    send({ method: 'textDocument/didClose', params: { textDocument } });
    await request('shutdown', null);
    send({ method: 'exit' });
    console.log('Rust LSP + embedded TypeScript worker smoke test passed');
  } finally {
    child.stdin.end(); child.kill();
    await closed;
    for (const entry of pending.values()) clearTimeout(entry.timeout);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
