const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const readline = require('readline');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unionbreeze-worker-'));
fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
fs.writeFileSync(path.join(root, 'types.ts'), `
export type ToastStyleType = 'normal' | 'wide';
interface ToastProps { styleType?: ToastStyleType }
type ShortHandToastProps = Omit<ToastProps, 'unused'>;
export function showSuccessToast(message: string, props?: Partial<ShortHandToastProps>) {}
`);
const usage = `import { showSuccessToast } from './types';
showSuccessToast('saved', { styleType: 'wide' });
const ordinary = 'wide';
`;
const usagePath = path.join(root, 'usage.ts');
fs.writeFileSync(usagePath, usage);

const child = spawn(process.execPath, [path.join(__dirname, 'worker.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map(); let nextId = 1;
lines.on('line', line => { const message = JSON.parse(line); const callback = pending.get(message.id); pending.delete(message.id); callback(message); });
function request(method, params) { return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, message => message.error ? reject(new Error(message.error)) : resolve(message.result)); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }); }

(async () => {
  await request('initialize', { root });
  const target = await request('resolveLiteral', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 1, character: 42 } });
  assert.equal(target.currentValue, 'wide');
  assert.equal(target.contextualTypeName, 'ToastStyleType');
  assert.deepEqual(target.assignableMembers.map(member => member.value), ['normal', 'wide']);
  assert(target.domain.uri.endsWith('/types.ts'));
  const ordinary = await request('resolveLiteral', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 2, character: 20 } });
  assert.equal(ordinary, null);
  child.kill(); fs.rmSync(root, { recursive: true, force: true });
})().catch(error => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); console.error(error); process.exitCode = 1; });
