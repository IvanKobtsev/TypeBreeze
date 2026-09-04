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
export function useGeneric<const TDefaults extends Partial<ToastProps>>(defaults: TDefaults) {}
`);
fs.writeFileSync(path.join(root, 'hooks.ts'), `import { ToastStyleType } from './types';
export type Options = { toastStyle?: ToastStyleType };
export function useHook(options: Options) {}
`);
const usage = `import { useHook } from './hooks';
import { useGeneric, ToastStyleType } from './types';
useHook({ toastStyle: 'wide' });
const ordinary = 'wide';
useGeneric({ styleType: 'wide' });
declare const status: ToastStyleType;
const compared = status === 'wide';
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
  const target = await request('resolveLiteral', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 2, character: 25 } });
  assert.equal(target.currentValue, 'wide');
  assert.equal(target.contextualTypeName, 'ToastStyleType');
  assert.deepEqual(target.assignableMembers.map(member => member.value), ['normal', 'wide']);
  assert(target.domain.uri.endsWith('/types.ts'));
  const toDeclaration = await request('navigationTargets', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 2, character: 25 } });
  assert.equal(toDeclaration.length, 1); assert(toDeclaration[0].uri.endsWith('/types.ts')); assert.equal(toDeclaration[0].range.start.line, 1);
  const fromDeclaration = await request('navigationTargets', { textDocument: { uri: pathToFileURL(path.join(root, 'types.ts')).href }, position: { line: 1, character: 46 } });
  assert.equal(fromDeclaration.length, 3); assert(fromDeclaration.every(location => location.uri.endsWith('/usage.ts')));
  const genericTarget = await request('resolveLiteral', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 4, character: 27 } });
  assert.equal(genericTarget.contextualTypeName, 'ToastStyleType');
  const comparisonTarget = await request('resolveLiteral', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 6, character: 29 } });
  assert.equal(comparisonTarget.contextualTypeName, 'ToastStyleType');
  const rename = await request('renamePlan', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 2, character: 25 }, newValue: 'expanded' });
  assert.equal(rename.oldValue, 'wide');
  assert.equal(rename.targets.length, 4);
  assert(rename.targets.some(target => target.uri.endsWith('/types.ts')));
  assert(rename.targets.some(target => target.uri.endsWith('/usage.ts') && target.expectedText === "'wide'"));
  const duplicateRename = await request('renamePlan', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 2, character: 25 }, newValue: 'normal' });
  assert.equal(duplicateRename, null);
  const declarationRename = await request('renamePlan', { textDocument: { uri: pathToFileURL(path.join(root, 'types.ts')).href }, position: { line: 1, character: 46 }, newValue: 'expanded' });
  assert.equal(declarationRename.targets.length, 4);
  const renamedTypes = fs.readFileSync(path.join(root, 'types.ts'), 'utf8').replaceAll("'wide'", "'expanded'");
  const renamedUsage = usage.replaceAll("'wide'", "'expanded'");
  await request('update', { uri: pathToFileURL(path.join(root, 'types.ts')).href, text: renamedTypes, version: 3 });
  await request('update', { uri: pathToFileURL(usagePath).href, text: renamedUsage, version: 3 });
  const secondRename = await request('renamePlan', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 2, character: 25 }, text: renamedUsage, clientVersion: 3, newValue: 'panoramic' });
  assert.equal(secondRename.oldValue, 'expanded');
  assert.equal(secondRename.targets.length, 4);
  await request('update', { uri: pathToFileURL(path.join(root, 'types.ts')).href, text: fs.readFileSync(path.join(root, 'types.ts'), 'utf8'), version: 4 });
  await request('update', { uri: pathToFileURL(usagePath).href, text: usage, version: 4 });
  const document = await request('documentUnions', { textDocument: { uri: pathToFileURL(path.join(root, 'types.ts')).href } });
  assert(document.literals.some(literal => literal.kind === 'declaration' && literal.currentValue === 'wide'));
  assert.equal(document.literals.find(literal => literal.kind === 'declaration' && literal.currentValue === 'wide').hasUsages, true);
  assert.equal(document.literals.find(literal => literal.kind === 'declaration' && literal.currentValue === 'normal').hasUsages, false);
  const changed = usage.replace("toastStyle: 'wide'", "toastStyle: 'normal'");
  const changedDocument = await request('documentUnions', { textDocument: { uri: pathToFileURL(usagePath).href }, text: changed, clientVersion: 2 });
  assert.equal(changedDocument.clientVersion, 2);
  assert(changedDocument.literals.some(literal => literal.kind === 'usage' && literal.currentValue === 'normal'));
  const changedTarget = await request('resolveLiteral', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 2, character: 25 }, text: changed, clientVersion: 2 });
  assert.equal(changedTarget.currentValue, 'normal');
  const ordinary = await request('resolveLiteral', { textDocument: { uri: pathToFileURL(usagePath).href }, position: { line: 3, character: 20 } });
  assert.equal(ordinary, null);
  child.kill(); fs.rmSync(root, { recursive: true, force: true });
})().catch(error => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); console.error(error); process.exitCode = 1; });
