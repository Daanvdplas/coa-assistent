import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run=(args)=>spawnSync(process.execPath,['evals/rag/scripts/run_promptfoo.mjs','--live','--suite','models','--ledger','evals/rag/results/local/never-created-test/ledger.json','--max-generations','60','--max-seconds','7200','--binary','/nonexistent-runtime',...args],{encoding:'utf8'});
test('the model launcher rejects an implicit phase before touching runtime or ledger',()=>{
 const result=run([]);assert.notEqual(result.status,0);assert.match(result.stderr,/Models vereist --phase/);
});
test('model smoke requires explicit cases and a single repetition',()=>{
 const result=run(['--phase','smoke','--cases','RAG26-01']);assert.notEqual(result.status,0);assert.match(result.stderr,/caseselectie en --repeat 1/);
});
test('the full protocol cannot silently filter cases or change repetitions',()=>{
 for (const extra of [['--cases','RAG26-01'],['--models','gpt-6.1-sol'],['--repeat','1']]) {
  const result=run(['--phase','pilot',...extra]);assert.notEqual(result.status,0);assert.match(result.stderr,/volledige modelproef behoudt/);
 }
});

test('browser-only model and case options cannot alter historical suites',()=>{
 for(const flag of ['--eval-id','--embedding-model']) {
  const result=spawnSync(process.execPath,['evals/rag/scripts/run_promptfoo.mjs','--suite','retrieval',flag,'e5-small-multilingual','--binary','/nonexistent-runtime'],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/uitsluitend.*browser/);
 }
});
test('browser execution requires one existing test and never accepts live generation',()=>{
 const result=spawnSync(process.execPath,['evals/rag/scripts/run_promptfoo.mjs','--suite','browser','--no-publish','--binary','/nonexistent-runtime'],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/browser.*eval-id/i);
});

test('typed browser preset flags cannot escape the browser runner or name an unknown preset',()=>{
 const elsewhere=spawnSync(process.execPath,['evals/rag/scripts/run_promptfoo.mjs','--suite','retrieval','--browser-preset','dense-k3-sections','--binary','/nonexistent-runtime'],{encoding:'utf8'});
 assert.notEqual(elsewhere.status,0);assert.match(elsewhere.stderr,/uitsluitend.*browser/);
 const unknown=spawnSync(process.execPath,['evals/rag/scripts/run_promptfoo.mjs','--suite','browser','--eval-id','quality-garden','--browser-preset','invented','--binary','/nonexistent-runtime'],{encoding:'utf8'});
 assert.notEqual(unknown.status,0);assert.match(unknown.stderr,/unknown.*preset/i);
});
