import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {diagnosticLauncher} from '../scripts/build-desktop.mjs';
const require=createRequire(import.meta.url),{buildReport}=require('../desktop/diagnostic.cjs');
const sample=()=>({platform:'win32',arch:'x64',versions:{electron:'45.2.1',chrome:'test'},checks:Array.from({length:8},(_,i)=>({name:'check-'+i,passed:true})),unexpectedRequests:0});
test('desktop receipt cannot claim business or native notification validation',()=>{
  const report=buildReport({...sample(),accessToken:'must-never-export',username:'must-never-export'});
  assert.equal(report.ok,true);assert.equal(report.applicationWorkflowsTested,false);
  assert.equal(report.scope,'offline_desktop_container');assert.equal(report.networkRequests,0);
  assert.doesNotMatch(JSON.stringify(report),/must-never-export/);
  assert.ok(report.manualChecks.some(x=>/notification/.test(x)));
});
test('incomplete, failed or unexpected-origin diagnostics never pass',()=>{
  for(const input of [{...sample(),checks:[]},{...sample(),unexpectedRequests:1},{...sample(),checks:[...sample().checks,{name:'failed',passed:false}]}])assert.equal(buildReport(input).ok,false);
});
test('Windows and macOS launchers pass only the diagnostic switch and preserve paths with spaces',()=>{
  assert.match(diagnosticLauncher('win32').text,/%~dp0Ludy Staging\.exe" --diagnostic/);
  assert.match(diagnosticLauncher('darwin').text,/exec "\.\/Ludy Staging\.app\/Contents\/MacOS\/Ludy Staging" --diagnostic/);
  assert.equal(diagnosticLauncher('darwin').mode,0o755);
  for(const platform of ['win32','darwin','linux'])assert.doesNotMatch(diagnosticLauncher(platform).text,/curl|wget|https?:|password|no-sandbox|xattr|spctl/);
  assert.throws(()=>diagnosticLauncher('unknown'));
});
