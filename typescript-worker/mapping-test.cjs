const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typebreeze-map-'));
fs.mkdirSync(path.join(root, 'src'));
fs.mkdirSync(path.join(root,'node_modules/prettier'),{recursive:true});
fs.writeFileSync(path.join(root,'node_modules/prettier/package.json'),JSON.stringify({name:'prettier',main:'index.js'}));
fs.writeFileSync(path.join(root,'node_modules/prettier/index.js'),`exports.resolveConfig=async()=>({});exports.clearConfigCache=async()=>{};exports.format=async text=>text+'// prettier-applied\\n';`);
fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
fs.writeFileSync(path.join(root, 'src/types.ts'), `export enum Kind { System='system', Mention='mention' }
export type Template<TKey extends Kind,TProps extends {}>={payload:TProps};
export interface Result { value:string }
export type Extractor<TKey extends Kind,TPayload,TResult=Result>={payload:TPayload};
export type Wide<TKey extends string>={key:TKey};
export type WideResult<TKey extends string,TResult=Result>={key:TKey};
export type BadResult<TKey extends Kind,TResult,TMore={}>={key:TKey};
export type MissingDefault<TKey extends Kind,TResult>={key:TKey};`);
fs.writeFileSync(path.join(root, 'src/templates.ts'), `import {Kind,Template} from '@/types';
export function System(value:Template<Kind.System,{}>){return value}
export function Access(value:Template<Kind.Mention,{}>){return value}
export let assignedLater: ((value: Template<Kind.System,{}>) => unknown);
export default function Mention(value:Template<Kind.Mention,{}>){return value}
export function Invalid(value:Template<Kind.Mention,{}>, extra:string){return value}`);
fs.writeFileSync(path.join(root, 'src/extractors.ts'), `import {Extractor,Kind,Result,WideResult} from '@/types';
export function SystemResult(value:Extractor<Kind.System,{}>):Result{return {value:'ok'}}
export function MentionText(value:Extractor<Kind.Mention,{},string>):string{return value.payload as string}
export function Anything(value:WideResult<'anything'>):Result{return {value:'ok'}}`);
fs.writeFileSync(path.join(root, 'mappings.brz.json'), JSON.stringify({ outputDirectory: 'src/generated', keyTypeParameter: 'TKey', resultTypeParameter:'TResult', mappings: { Templates: { path: 'src/types.ts', type: 'Template', requireAllKeys: true }, Extractors:{path:'src/types.ts',type:'Extractor',requireAllKeys:true}, WideResults:{path:'src/types.ts',type:'WideResult',requireAllKeys:true}, Wides:{path:'src/types.ts',type:'Wide',requireAllKeys:false} } }));
const child = spawn(process.execPath, [path.join(__dirname, 'worker.cjs')], { env: { ...process.env, NODE_PATH: path.resolve(__dirname, '../node_modules') }, stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '', id = 0; const pending = new Map();
child.stdout.on('data', chunk => { buffer += chunk; for (let end; (end = buffer.indexOf('\n')) >= 0;) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(message.id)?.(message.result); pending.delete(message.id); } });
function request(method, params = {}) { return new Promise(resolve => { const requestId = ++id; pending.set(requestId, resolve); child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n'); }); }
function typeParams(source, name) { const index=source.indexOf(name);const before=source.slice(0,index);return { textDocument: { uri: pathToFileURL(path.join(root, 'src/types.ts')).href }, position: { line: before.split('\n').length - 1, character: index-before.lastIndexOf('\n') }, text: source, clientVersion: 1, keyTypeParameter: 'TKey' }; }
(async () => {
  try {
    await request('initialize', { root, extensions: false });
    const source = fs.readFileSync(path.join(root, 'src/types.ts'), 'utf8');
    await request('update',{uri:pathToFileURL(path.join(root,'src/templates.ts')).href,version:2,text:`import {Kind,Template} from '@/types';\nexport function System(value:Template<Kind.System,{}>){return value}`});
    const finite = await request('mappingTypeAt', typeParams(source, 'Template'));
    assert.equal(finite.valid, true); assert.equal(finite.finiteKeyDomain, true); assert.equal(finite.keyDomainType, 'Kind');
    const infinite = await request('mappingTypeAt', typeParams(source, 'Wide'));
    assert.equal(infinite.valid, true); assert.equal(infinite.finiteKeyDomain, false);
    assert.match((await request('mappingTypeAt',typeParams(source,'BadResult'))).reason,/final generic parameter/);
    assert.match((await request('mappingTypeAt',typeParams(source,'MissingDefault'))).reason,/default type/);
    const plan = await request('mappingGeneration');
    assert.deepEqual(plan.diagnostics, []);const template=plan.files.find(file=>file.path.endsWith('Template.map.ts'));const extractor=plan.files.find(file=>file.path.endsWith('Extractor.map.ts'));const wide=plan.files.find(file=>file.path.endsWith('WideResult.map.ts'));const redundant=plan.files.find(file=>file.path.endsWith('Wide.map.ts'));
    fs.mkdirSync(path.join(root,'config'));
    fs.copyFileSync(path.join(root,'mappings.brz.json'),path.join(root,'config/typebreeze.json'));
    fs.rmSync(path.join(root,'mappings.brz.json'));
    const customPlan=await request('mappingGeneration',{configFilePath:'config/typebreeze.json'});
    assert.deepEqual(customPlan.diagnostics,[]);assert.equal(customPlan.files.length,plan.files.length);
    const missingDefault=await request('mappingGeneration');assert.equal(missingDefault.diagnostics[0].path,'mappings.brz.json');
    for(const invalidPath of ['', '../outside.json', path.resolve(root,'config/typebreeze.json')]){
      const invalidPlan=await request('mappingGeneration',{configFilePath:invalidPath});assert.match(invalidPlan.diagnostics[0].message,/inside the workspace/);
    }
    assert.match(template.content, /^\/\/----------------------\n\/\/ <auto-generated>/);
    assert.match(template.content,/\/\/ prettier-applied\n$/);
    assert.match(template.content, /from "@\/templates"/); assert.match(template.content, /\[Kind\.System\]: System/);
    assert.match(template.content, /\[Kind\.Mention\]: Access/);
    assert.match(template.content, /as const satisfies Record<Kind, unknown>/); assert.doesNotMatch(template.content, /Kind\.Mention.*Mention/);
    assert.match(extractor.content,/\[Kind\.System\]: \(\.\.\.args: never\[\]\) => Result/);assert.match(extractor.content,/\[Kind\.Mention\]: \(\.\.\.args: never\[\]\) => string/);
    assert.match(wide.content,/satisfies Record<PropertyKey, \(\.\.\.args: never\[\]\) => Result>/);
    assert.doesNotMatch(redundant.content,/satisfies/);
    for(const file of plan.files){const target=path.join(root,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.content);}
    const ts=require('typescript');const parsed=ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile).config,ts.sys,root);let generatedDiagnostics=ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,parsed.options)).filter(item=>item.file?.fileName.replace(/\\/g,'/').includes('/generated/'));
    assert.deepEqual(generatedDiagnostics.map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n')),[]);
    fs.writeFileSync(path.join(root,'src/extractors.ts'),fs.readFileSync(path.join(root,'src/extractors.ts'),'utf8').replace(":Result{return {value:'ok'}}",":string{return 'wrong'}"));
    const invalidReturnPlan=await request('mappingGeneration',{configFilePath:'config/typebreeze.json'});for(const file of invalidReturnPlan.files){fs.writeFileSync(path.join(root,file.path),file.content);}
    const reparsed=ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile).config,ts.sys,root);generatedDiagnostics=ts.getPreEmitDiagnostics(ts.createProgram(reparsed.fileNames,reparsed.options)).filter(item=>item.file?.fileName.replace(/\\/g,'/').includes('/generated/'));
    assert(generatedDiagnostics.length>0);
    const sourceDiagnostics = plan.diagnosticDocuments.find(item => item.uri.endsWith('templates.ts')).diagnostics;
    assert.equal(sourceDiagnostics.length, 2); assert(sourceDiagnostics.some(item => item.message.includes('Default exports are not supported'))); assert(sourceDiagnostics.some(item => item.message.includes('2 parameters were found')));
    assert.equal(plan.occurrences.filter(item => item.kind === 'connector').length, 4); assert.equal(plan.occurrences.filter(item => item.kind === 'component').length, 7);
    console.log('Mapping generation tests passed');
  } finally { child.kill(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
