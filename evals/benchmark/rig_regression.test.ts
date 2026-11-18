import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {buildConfig}=require('../rag/promptfoo/cases.cjs');
const ID='regression-12-20261118';
test('exhaustive visitor regression is available on twelve sources in both local RAG matrices',()=>{
  const retrieval=buildConfig({COA_PROMPTFOO_SUITE:'retrieval',COA_PROMPTFOO_DATASET:ID});
  const quality=buildConfig({COA_PROMPTFOO_SUITE:'quality',COA_PROMPTFOO_DATASET:ID});
  assert.equal(retrieval.tests.length,16);
  assert.equal(quality.tests.length,24);
  assert.ok(retrieval.tests.every((r:any)=>r.vars.dataset===ID&&r.vars.case_id==='IND26-01'));
  assert.equal(retrieval.tests[0].vars.question,'Welke activiteiten uit deze bronnen zijn binnen, beginnen om 14.00 uur, zijn gratis en hebben het materiaal voor de activiteit al aanwezig? Zet alle passende opties naast elkaar met de dag, eindtijd en wat je daar doet.');
});
test('current Rig plans require an explicit provider-attempt limit and preserve its runtime unit',async()=>{
  const {plan,catalog}=await import('./adapter.ts');
  const old=process.env.COA_BENCHMARK_RIG_READY;process.env.COA_BENCHMARK_RIG_READY='1';
  process.env.COA_RAG_BINARY??='/usr/bin/true';
  try{
    const selected={datasets:[ID],suites:['assistant-rig'],authorization:{confirmed:true,max_attempts:10,max_seconds:300}};
    const p=plan(selected);
    assert.equal(p.can_start,true);
    assert.equal(p.totals.model,2);
    assert.equal((p.groups[0] as any).max_provider_attempts,10);
    assert.equal((catalog().suites.find(s=>s.id==='assistant-rig') as any).unit,'provider_attempts');
    assert.ok(catalog().default_selection.datasets.includes(ID));
    const blocked=plan({...selected,authorization:{confirmed:true,max_attempts:1,max_seconds:300}});
    assert.equal(blocked.can_start,false);
  }finally{if(old===undefined)delete process.env.COA_BENCHMARK_RIG_READY;else process.env.COA_BENCHMARK_RIG_READY=old;}
});
test('the current Rig suite supports every existing twelve-source case and the separate exhaustive regression',async()=>{
  const {plan}=await import('./adapter.ts');const old=process.env.COA_BENCHMARK_RIG_READY;process.env.COA_BENCHMARK_RIG_READY='1';
  try{const p=plan({datasets:['demo-12-20261118',ID],suites:['assistant-rig'],authorization:{confirmed:true,max_attempts:180,max_seconds:7200}});assert.equal(p.can_start,true);assert.deepEqual(p.groups.map(g=>g.case_count),[17,1]);assert.equal(p.totals.model,36);}finally{if(old===undefined)delete process.env.COA_BENCHMARK_RIG_READY;else process.env.COA_BENCHMARK_RIG_READY=old;}
});
test('the provider-attempt ceiling covers all selected Rig groups together',async()=>{
  const {plan}=await import('./adapter.ts');const old=process.env.COA_BENCHMARK_RIG_READY;process.env.COA_BENCHMARK_RIG_READY='1';
  try{const p=plan({datasets:['demo-12-20261118',ID],suites:['assistant-rig'],authorization:{confirmed:true,max_attempts:170,max_seconds:7200}});assert.equal(p.totals.provider_attempts,180);assert.equal(p.can_start,false);assert.ok(p.groups.every(g=>g.block_reason));}finally{if(old===undefined)delete process.env.COA_BENCHMARK_RIG_READY;else process.env.COA_BENCHMARK_RIG_READY=old;}
});
