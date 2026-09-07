const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const T = require('typescript');
const createExtensions = require('./extensions.cjs');

function fixture(files, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typebreeze-ext-'));
  const overlays = new Map();
  function write(name, text) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  write('tsconfig.json', JSON.stringify({ ...config, compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve', ...config.compilerOptions } }));
  for (const [name, text] of Object.entries(files)) write(name, text);
  const service = createExtensions(T, root, overlays);
  function params(marked, name = 'use.ts', documents = []) {
    const at = marked.lastIndexOf('|'); assert(at >= 0);
    const text = marked.slice(0, at) + marked.slice(at + 1);
    const lines = text.slice(0, at).split('\n');
    return { textDocument: { uri: pathToFileURL(path.join(root, name)).href }, text, clientVersion: 1,
      position: { line: lines.length - 1, character: lines.at(-1).length }, documents };
  }
  return { root, overlays, service, write, params,
    complete(marked, name, documents) {
      const request = params(marked, name, documents);
      const result = service.completions(request);
      result.candidates = result.candidates.map(candidate => ({ ...candidate,
        plan: service.callPlan({ ...request, candidateId: candidate.id, snapshot: result.snapshot }) })).filter(candidate => candidate.plan);
      return result;
    },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
function output(candidate) {
  assert(candidate, 'Expected extension candidate');
  let text = candidate.plan.expectedText;
  for (const edit of [...candidate.plan.edits].sort((a, b) => b.start - a.start)) {
    assert.equal(text.slice(edit.start, edit.end), edit.expectedText);
    text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
  }
  return text.slice(0, candidate.plan.caretOffset) + '|' + text.slice(candidate.plan.caretOffset);
}
let assertions = 0;
function test(name, files, body, config) {
  const f = fixture({ 'use.ts': '', ...files }, config);
  try { body(f); console.log(`PASS ${name}`); assertions++; }
  finally { f.close(); }
}

test('eligibility and receiver compatibility', {
  'strings.ext.ts': `export function truncate(value: string, length: number) { return value.slice(0, length); }
    export const upper = (value: string) => value.toUpperCase();
    export const lower = function(value: string) { return value.toLowerCase(); };
    export function numeric(value: number) { return value; }
    export function inferred(value = '') { return value; }
    export function rest(...value: string[]) { return value; }
    export function bound(this: string, value: string) { return value; }
    export declare function ambientInSource(value: string): string;
    function privateFunction(value: string) { return value; }
    export default (value: string) => value;`,
  'plain.ts': 'export function excluded(value: string) { return value; }',
  'ambient.ext.d.ts': 'export declare function ambient(value: string): string;',
}, f => {
  const result = f.complete('const title = "hello"; title.|');
  assert.deepEqual(result.candidates.map(item => item.name).sort(), ['lower', 'truncate', 'upper']);
  const truncate = result.candidates.find(item => item.name === 'truncate');
  assert.match(output(truncate), /import \{ truncate \} from '\.\/strings\.ext';/);
  assert.match(output(truncate), /truncate\(title, \|\)/);
  assert.match(output(result.candidates.find(item => item.name === 'upper')), /upper\(title\)\|/);
});

test('completion discovery defers plans and filters prefixes', {
  'strings.ext.ts': `export function truncate(value: string, length: number) { return value; }
    export function upper(value: string) { return value; }`,
}, f => {
  const request = f.params('const title = "hello"; title.tr|');
  const result = f.service.completions(request);
  assert.deepEqual(result.candidates.map(item => item.name), ['truncate']);
  assert.equal(result.candidates[0].plan, undefined);
  assert.equal(result.expectedText, request.text);
  assert(f.service.callPlan({ ...request, candidateId: result.candidates[0].id, snapshot: result.snapshot }));
});

test('generics, structure, narrowing and overloads', {
  'types.ext.ts': `export function head<T>(value: readonly T[]) { return value[0]; }
    export function named<T extends {name: string}>(value: T) { return value.name; }
    export function pair<T>(value: T, other: T) { return [value, other]; }
    export function overloaded(value: number): number;
    export function overloaded(value: string, count: number): string;
    export function overloaded(value: string | number, count?: number) { return value; }
    export function exact(value: {name: string}) { return value.name; }`,
}, f => {
  let result = f.complete('const values = [1, 2]; values.|');
  assert.equal(result.candidates.find(item => item.name === 'head')?.returnType, 'T');
  assert(!result.candidates.some(item => item.name === 'named'));
  result = f.complete('const value = { name: "x", extra: true }; value.|');
  assert(result.candidates.some(item => item.name === 'named'));
  assert(result.candidates.some(item => item.name === 'exact'));
  result = f.complete('function run(value: string | number) { if (typeof value === "string") { value.| } }');
  assert(result.candidates.some(item => item.name === 'overloaded'));
  assert.match(output(result.candidates.find(item => item.name === 'pair')), /pair\(value, \|\)/);
});

test('imports, aliases, namespace bindings and name collisions', {
  'strings.ext.ts': `export function upper(value: string) { return value.toUpperCase(); }
    export function lower(value: string) { return value.toLowerCase(); }
    export default function trim(value: string) { return value.trim(); }`,
}, f => {
  let result = f.complete('import { upper as up } from "./strings.ext"; const value = "x"; value.|');
  assert.match(output(result.candidates.find(item => item.name === 'upper')), /up\(value\)\|/);
  assert.equal(result.candidates.find(item => item.name === 'upper').plan.edits.length, 1);
  assert.match(output(result.candidates.find(item => item.name === 'lower')), /\{ upper as up, lower \}/);
  result = f.complete('import * as strings from "./strings.ext"; const value = "x"; value.|');
  assert.match(output(result.candidates.find(item => item.name === 'upper')), /strings.upper\(value\)/);
  result = f.complete('const upper = 1; const value = "x"; value.|');
  assert.match(output(result.candidates.find(item => item.name === 'upper')), /upper as upper2/);
  assert.match(output(result.candidates.find(item => item.name === 'trim')), /import trim from/);
});

test('expression boundaries, optional arguments and excluded contexts', {
  'strings.ext.ts': `export function upper(value: string, unused?: number) { return value; }
    export function rest(value: string, ...others: string[]) { return value; }
    export function tupleRest(value: string, ...others: [count: number, suffix?: string]) { return value; }`,
}, f => {
  assert.match(output(f.complete('const value = "x"; value.|').candidates.find(item => item.name === 'tupleRest')), /tupleRest\(value, \|\)/);
  for (const expression of ['user.name', 'getName()', 'names[0]', '(true ? "a" : "b")']) {
    const result = f.complete(`const user = {name: "x"}; const names = ["x"]; function getName(){return "x";} const result = ${expression}.up|;`);
    assert(output(result.candidates.find(item => item.name === 'upper')).includes(`upper(${expression})|;`));
  }
  for (const source of ['const x = "a"; x?.|', 'const x = "a"; // x.|', 'const x = "x.|";', 'type X = string.|', 'import { x.| } from "foo"']) {
    assert.equal(f.complete(source).candidates.length, 0, source);
  }
});

test('project updates, unsaved source and stale plans', { 'strings.ext.ts': 'export function upper(value: string) { return value; }' }, f => {
  const params = f.params('const x = "x"; x.|');
  let result = f.service.completions(params);
  const candidate = result.candidates[0];
  assert(f.service.callPlan({ ...params, candidateId: candidate.id, snapshot: result.snapshot }));
  f.write('strings.ext.ts', 'export function upper(value: number) { return value; }');
  assert.equal(f.service.callPlan({ ...params, candidateId: candidate.id, snapshot: result.snapshot }), null);
  f.write('new.ext.ts', 'export const fresh = (value: string) => value;');
  result = f.service.completions(params);
  assert.deepEqual(result.candidates.map(item => item.name), ['fresh']);
  fs.renameSync(path.join(f.root, 'new.ext.ts'), path.join(f.root, 'new.ts'));
  assert.equal(f.service.completions(params).candidates.length, 0);
  const uri = pathToFileURL(path.join(f.root, 'virtual.ext.ts')).href;
  result = f.complete('const x = "x"; x.|', 'use.ts', [{ textDocument: { uri }, text: 'export function virtual(value: string) { return value; }', clientVersion: 2 }]);
  assert(result.candidates.some(item => item.name === 'virtual'));
});

test('excluded project files and dependencies', {
  'hidden/hidden.ext.ts': 'export function hidden(value: string) { return value; }',
  'node_modules/pkg/pkg.ext.ts': 'export function external(value: string) { return value; }',
  'visible.ext.ts': 'export function visible(value: string) { return value; }',
}, f => {
  assert.deepEqual(f.complete('const x = "x"; x.|').candidates.map(item => item.name), ['visible']);
}, { exclude: ['hidden', 'node_modules'] });

test('local functions and TSX', {
  'local.ext.tsx': 'const local = (value: string) => value;',
}, f => {
  const result = f.complete('const local = (value: string) => value; const x = "x"; const jsx = <div>{x.|}</div>;', 'local.ext.tsx');
  assert.match(output(result.candidates.find(item => item.name === 'local')), /\{local\(x\)\|\}/);
  assert.equal(result.candidates[0].plan.edits.length, 1);
});

test('same-file exports and lexical accessibility', {}, f => {
  const source = `export function upper(value: string) { return value; }
    export default function trim(value: string) { return value; }
    function outer() { const inner = (value: string) => value; }
    const value = "x"; value.|`;
  const result = f.complete(source, 'local.ext.ts');
  assert.deepEqual(result.candidates.map(item => item.name).sort(), ['trim', 'upper']);
  assert(result.candidates.every(item => item.plan.edits.length === 1));
});

test('path mappings', { 'src/strings.ext.ts': 'export function upper(value: string) { return value; }' }, f => {
  const result = f.complete('const value = "x"; value.|', 'deep/nested/use.ts');
  assert.match(output(result.candidates[0]), /from '@ext\/strings.ext'/);
}, { compilerOptions: { baseUrl: '.', paths: { '@ext/*': ['src/*'] } } });

test('NodeNext module extensions', {
  'package.json': '{"type":"module"}',
  'strings.ext.ts': 'export function upper(value: string) { return value; }',
}, f => {
  assert.match(output(f.complete('const value = "x"; value.|').candidates[0]), /from '\.\/strings.ext.js'/);
}, { compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } });

test('type-only imports, defaults, renamed exports and compatible this', {
  'strings.ext.ts': `export function upper(value: string, limit = 1) { return value; }
    function original(value: string) { return value; } export { original as renamed };
    export function free(this: void, value: string) { return value; }`,
}, f => {
  const result = f.complete('import type { upper } from "./strings.ext"; const x = "x"; x.|');
  assert.match(output(result.candidates.find(item => item.name === 'upper')), /upper as upper2/);
  assert.match(output(result.candidates.find(item => item.name === 'original')), /renamed as original/);
  assert(result.candidates.some(item => item.name === 'free'));
});

test('generic constraints reject incompatible unions and retain literal inference', {
  'strings.ext.ts': `export function stringOnly<T extends string>(value: T) { return value; }
    export function keyed<T extends {name: string}>(value: T, key: keyof T) { return value[key]; }
    export function anyValue(value: any) { return value; }
    export function unknownValue(value: unknown) { return value; }`,
}, f => {
  let result = f.complete('function run(x: string | number) { x.| }');
  assert(!result.candidates.some(item => item.name === 'stringOnly'));
  result = f.complete('const x = "literal" as const; x.|');
  assert.equal(result.candidates.find(item => item.name === 'stringOnly')?.returnType, 'T');
  result = f.complete('const x = {name: "a", count: 1}; x.|');
  assert(result.candidates.some(item => item.name === 'keyed'));
  assert(result.candidates.some(item => item.name === 'unknownValue'));
});

test('same-named candidates and shebang/directive imports', {
  'one.ext.ts': 'export function upper(value: string) { return value; }',
  'two.ext.ts': 'export function upper(value: string) { return value; }',
}, f => {
  const result = f.complete('#!/usr/bin/env node\n"use strict";\nconst value = "x"; value.|');
  assert.equal(result.candidates.length, 2);
  assert.notEqual(result.candidates[0].id, result.candidates[1].id);
  assert.match(output(result.candidates[0]), /^#!\/usr\/bin\/env node\n"use strict";\nimport /);
});

test('Windows dependency snapshots and UTF-16 receiver offsets', {
  'strings.ext.ts': 'export function upper(value: string) {\r\n  return value;\r\n}\r\n',
}, f => {
  const result = f.complete('const emoji = "😀"; const value = "x"; value.|');
  assert(result.documents.every(document => !document.expectedText.includes('\r')));
  assert.match(output(result.candidates[0]), /const emoji = "😀"; const value = "x"; upper\(value\)\|/);
});

console.log(`${assertions} extension scenarios passed`);
