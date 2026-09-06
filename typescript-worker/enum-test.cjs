const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const readline = require('readline');

async function conversion(files, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typebreeze-enum-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'worker.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  let id = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); const callbacks = pending.get(message.id); pending.delete(message.id);
    message.error ? callbacks.reject(new Error(message.error)) : callbacks.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  try {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', ...options.compilerOptions } }));
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
    await request('initialize', { root });
    const source = files['enum.ts'];
    const plan = await request('enumToUnionPlan', {
      textDocument: { uri: pathToFileURL(path.join(root, 'enum.ts')).href }, position: { line: 0, character: source.indexOf('enum') + 5 }, text: source, clientVersion: 1,
      documents: Object.entries(options.overlays || {}).map(([file, text]) => ({ textDocument: { uri: pathToFileURL(path.join(root, file)).href }, text, clientVersion: 2 })),
    });
    const output = { ...files, ...options.overlays };
    for (const snapshot of plan.documents) {
      const file = path.basename(new URL(snapshot.uri).pathname);
      assert.equal(output[file], snapshot.expectedText);
      const toOffset = point => { const lines = snapshot.expectedText.split('\n'); return lines.slice(0, point.line).reduce((total, line) => total + line.length + 1, 0) + point.character; };
      const edits = plan.edits.filter(edit => edit.uri === snapshot.uri).map(edit => ({ ...edit, start: toOffset(edit.range.start), end: toOffset(edit.range.end) })).sort((a, b) => b.start - a.start);
      for (const edit of edits) {
        assert.equal(output[file].slice(edit.start, edit.end), edit.expectedText);
        output[file] = output[file].slice(0, edit.start) + edit.newText + output[file].slice(edit.end);
      }
    }
    // Preview must not leave transformed text in the worker's overlays.
    const repeated = await request('enumToUnionPlan', { textDocument: { uri: pathToFileURL(path.join(root, 'enum.ts')).href }, position: { line: 0, character: source.indexOf('enum') + 5 } });
    assert.equal(repeated.reason, plan.reason);
    assert.deepEqual(repeated.edits, plan.edits);
    return { plan, output };
  } finally { child.kill(); fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => {
  for (const declaration of ["export enum E { normal = 'whatever', wide = 'whatever' }", 'export enum E { normal, wide }', "export enum E { normal = 4, wide = 'x' }", 'export const enum E { normal, wide }']) {
    const { plan, output } = await conversion({ 'enum.ts': declaration, 'use.ts': "import { E } from './enum'; const value: E = E.wide; const object = { [E.normal]: 'smth' };" });
    assert.equal(plan.reason, null, plan.reason);
    assert.equal(plan.needsObject, false);
    assert.match(output['enum.ts'], /export type E = 'normal' \|\s*'wide';/);
    assert.match(output['use.ts'], /value: E = 'wide'/);
    assert.match(output['use.ts'], /\{ normal: 'smth' \}/);
    assert.match(output['use.ts'], /type E/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'export enum E { a, b }', 'use.ts': "import { E as Alias } from './enum'; const values = Object.values(Alias); const v = Alias['a']; type Member = Alias.b; type Obj = typeof Alias;" });
    assert.equal(plan.reason, null, plan.reason);
    assert.equal(plan.needsObject, true);
    assert.match(output['enum.ts'], /as const satisfies \{ \[K in E\]: K; \}/);
    assert.match(output['use.ts'], /const v = 'a'/);
    assert.match(output['use.ts'], /type Member = 'b'/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': "export enum E { /** first */ a = 9, // second\n 'x-y' = 'z', '__proto__' = 8 }", 'use.ts': "import * as ns from './enum'; const o = { [ns.E['x-y']]: 1, [ns.E.__proto__]: 2 }; const v = ns.E.a; function f() { const E = { a: 9 }; return E.a; }" });
    assert.equal(plan.reason, null, plan.reason);
    assert.match(output['enum.ts'], /\/\*\* first \*\//);
    assert.match(output['enum.ts'], /\/\/ second/);
    assert.match(output['use.ts'], /\{ 'x-y': 1, \['__proto__'\]: 2 \}/);
    assert.match(output['use.ts'], /return E.a/);
    assert.doesNotMatch(output['use.ts'], /import \*/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'export enum E {}' });
    assert.equal(plan.reason, null, plan.reason); assert.match(output['enum.ts'], /export type E = never;/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'export enum E { a, b }', 'use.ts': "import { E } from './enum'; const v = E.a;" }, { overlays: { 'use.ts': "import { E } from './enum'; const v = E.b;" } });
    assert.equal(plan.reason, null, plan.reason); assert.match(output['use.ts'], /v = 'b'/);
  }
  for (const [declaration, usage, reason] of [
    ['export enum E { a, b }', 'const x = E[0];', /reverse lookups/],
    ['export enum E { a, b }', 'E.a = 2;', /writes/],
    ['export enum E { a, b } export namespace E { export const c = 3; }', '', /Merged/],
    ['export declare enum E { a, b }', '', /Ambient/],
    ['export enum E { a, b }', 'const n: number = E.a;', /introduce TypeScript error/],
  ]) {
    const { plan } = await conversion({ 'enum.ts': declaration, 'use.ts': `import { E } from './enum'; ${usage}` });
    assert.match(plan.reason, reason); assert.equal(plan.edits.length, 0);
  }
  {
    const { plan, output } = await conversion({
      'enum.ts': 'export enum E { a, b } export const other = 4;',
      'barrel.ts': "export { E as Alias, other } from './enum';",
      'use.ts': "import { Alias, other } from './barrel'; const v: Alias = Alias.a; console.log(other);",
    }, { compilerOptions: { verbatimModuleSyntax: true } });
    assert.equal(plan.reason, null, plan.reason);
    assert.match(output['barrel.ts'], /type E as Alias/);
    assert.match(output['use.ts'], /type Alias, other/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'export enum E { a, b }', 'use.ts': "import { E } from './enum'; export { E }; const v: E = E.a;" }, { compilerOptions: { verbatimModuleSyntax: true } });
    assert.equal(plan.reason, null, plan.reason); assert.match(output['use.ts'], /export \{ type E \}/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'export enum E { a, b }', 'use.ts': "import { E } from './enum'; declare const key: keyof typeof E; const v = E[key]; type Single = typeof E.a;" });
    assert.equal(plan.reason, null, plan.reason); assert.equal(plan.needsObject, true);
    assert.match(output['use.ts'], /type Single = 'a'/);
    assert.match(output['use.ts'], /E\[key\]/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'export enum E { a, b }', 'use.ts': "import { E } from './enum'; const v = E.a; const existingError: number = 'bad';" });
    assert.equal(plan.reason, null, plan.reason); assert.match(output['use.ts'], /existingError: number = 'bad'/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'enum E { a, b }\nconst v = E.a;' });
    assert.equal(plan.reason, null, plan.reason); assert.doesNotMatch(output['enum.ts'], /export/);
    assert.match(output['enum.ts'], /const v = 'a'/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': "export enum E { '__proto__', 'x-y' }", 'use.ts': "// import documentation\nimport { E } from './enum'; // module comment\nconst all = Object.values(E); const value: E = E['x-y'];" });
    assert.equal(plan.reason, null, plan.reason); assert.match(output['enum.ts'], /\['__proto__'\]: '__proto__'/);
    assert.equal(output['use.ts'].split('// import documentation').length - 1, 1);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'export enum E { a, b }', 'use.ts': "import './setup';\nimport { E } from './enum';\nconst v = E.a;", 'setup.ts': 'export {};' });
    assert.equal(plan.reason, null, plan.reason);
    assert.doesNotMatch(output['use.ts'], /from ['"]\.\/enum|import ['"]\.\/enum/);
    assert.match(output['use.ts'], /import '\.\/setup'/);
    assert.match(output['use.ts'], /const v = 'a'/);
  }
  {
    const { plan, output } = await conversion({ 'enum.ts': 'export enum E { a, b }', 'use.ts': "// import documentation\nimport { E } from './enum'; // module comment\nconst value: E = E.a;" });
    assert.equal(plan.reason, null, plan.reason);
    assert.equal(output['use.ts'].split('// import documentation').length - 1, 1, output['use.ts']);
    assert.equal(output['use.ts'].split('// module comment').length - 1, 1, output['use.ts']);
  }
  console.log('Enum conversion regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
