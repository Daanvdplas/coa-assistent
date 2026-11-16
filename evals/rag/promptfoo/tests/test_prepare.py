import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from test_assertions import HERE,local_record
from test_provider import load_provider
from test_environment import isolate_runtime_environment

class PreparedExecutionTest(unittest.TestCase):
    def setUp(self):
        isolate_runtime_environment(self)
        path=HERE/'prepare.py';self.assertTrue(path.exists(),'Fresh batch preparation is not implemented')
        spec=importlib.util.spec_from_file_location('coa_prepare_test',path);self.prepare=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.prepare)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        binary=self.root/'runtime';binary.write_text('#!fake');binary.chmod(0o700)
        self.env={'COA_RAG_BINARY':str(binary),'COA_PROMPTFOO_ARTIFACT_DIR':str(self.root/'artifacts'),'COA_PROMPTFOO_EXECUTION_ID':'fresh-test-execution'}
        self.rows=[]
        for case in ('P01','P02'):
            native=local_record(case_id=case)
            self.rows.append({'vars':{**self.prepare.provider.DEFAULTS,'filters':{},'dataset':'legacy','case_id':case,'question':native['question']}})

    def test_exact_selected_cases_share_preparation_without_native_assessment(self):
        seen=[]
        def execute(command,env,timeout,cwd):
            seen.append(command)
            cases=command[command.index('--cases')+1].split(',')
            output=Path(command[command.index('--output')+1])
            output.write_text(''.join(json.dumps(local_record(case_id=case)['record'])+'\n' for case in cases))
            return subprocess.CompletedProcess(command,0,b'{}',b'')
        request={'schema_version':1,'execution_id':'fresh-test-execution','tests':self.rows}
        output=self.root/'prepared.json'
        with patch.dict(os.environ,self.env),patch.object(self.prepare.provider,'_execute',side_effect=execute):
            manifest=self.prepare.prepare(request,output)
        self.assertEqual(len(seen),1);self.assertEqual(set(seen[0][seen[0].index('--cases')+1].split(',')),{'P01','P02'})
        self.assertNotIn('assess',seen[0]);self.assertEqual(len(manifest['records']),2)
        provider=load_provider()
        with patch.dict(os.environ,{**self.env,'COA_PROMPTFOO_PREPARED':str(output)}),patch.object(provider,'_execute') as execute_again:
            result=provider.call_api('',{},self.rows[0])
        self.assertNotIn('error',result);self.assertEqual(execute_again.call_count,0)
        self.assertEqual(result['metadata']['execution_mode'],'fresh_batch_retrieval')

    def test_native_independent_per_case_filters_are_not_overridden_with_a_global_flag(self):
        rows=[]
        for case,filters in [('IND26-01',{'environment':'indoor'}),('IND26-03',{'weekdays':['sunday']})]:
            rows.append({'vars':{**self.prepare.provider.DEFAULTS,'mode':'local','apply_filters':True,'selection':'activity_expansion','dataset':'independent-20261103','case_id':case,'question':self.prepare.provider._question('independent-20261103',case),'filters':filters}})
        observed=[]
        def execute(command,env,timeout,cwd):
            observed.append(command)
            self.assertNotIn('--query-filters',command)
            native=[]
            for row in rows:
                record=local_record()['record'];record.update(case_id=row['vars']['case_id'],question=row['vars']['question']);native.append(record)
            Path(command[command.index('--output')+1]).write_text(''.join(json.dumps(record)+'\n' for record in native))
            return subprocess.CompletedProcess(command,0,b'{}',b'')
        with patch.dict(os.environ,self.env),patch.object(self.prepare.provider,'_execute',side_effect=execute):
            self.prepare.prepare({'schema_version':1,'execution_id':'fresh-test-execution','tests':rows},self.root/'ind-prepared.json')
        self.assertEqual(len(observed),1)

    def test_changed_native_record_or_wrong_execution_id_is_not_a_cache_hit(self):
        provider=load_provider()
        base=Path(self.env['COA_PROMPTFOO_ARTIFACT_DIR']);base.mkdir()
        native=base/'prepared-case.json'
        original=json.dumps(local_record()['record']).encode()
        native.write_bytes(original)
        manifest={'schema_version':1,'execution_id':'fresh-test-execution','records':{
            provider.request_key(self.rows[0]['vars']):{'path':str(native),'sha256':hashlib.sha256(original).hexdigest()}
        }}
        output=self.root/'prepared.json';output.write_text(json.dumps(manifest))
        env={**self.env,'COA_PROMPTFOO_PREPARED':str(output)}
        with patch.dict(os.environ,env),patch.object(provider,'_execute') as execute:
            result=provider.call_api('',{},self.rows[0])
            self.assertNotIn('error',result)
            self.assertEqual(result['metadata']['execution_mode'],'fresh_batch_retrieval')
            execute.assert_not_called()
            for changed in ('execution_id','native_bytes'):
                with self.subTest(changed=changed):
                    native.write_bytes(original+b' ' if changed=='native_bytes' else original)
                    execution='another-execution' if changed=='execution_id' else env['COA_PROMPTFOO_EXECUTION_ID']
                    with patch.dict(os.environ,{'COA_PROMPTFOO_EXECUTION_ID':execution}):
                        result=provider.call_api('',{},self.rows[0])
                    self.assertIn('error',result)
                    execute.assert_not_called()

    def test_browser_preparation_pins_the_resolved_model_before_retrieval(self):
        model='e5-small-multilingual'
        variables={**self.rows[0]['vars'],'method':'dense','top_k':5,'browser_eval_id':'garden-time-location','embedding_model':model}
        spec=next(row for row in json.loads((HERE.parent/'embedding-models.json').read_text()) if row['id']==model)
        identity={'provider':'local-fastembed','model':spec['repository']+'@'+'a'*40,'sdk':spec['sdk'],'dimensions':spec['dimensions'],'encoding':spec['encoding']+'; model_files_sha256='+'b'*64,'document_prefix':spec['document_prefix'],'query_prefix':spec['query_prefix']}
        seen=[]
        def execute(command,env,timeout,cwd):
            seen.append(command)
            if command[2]=='embedding-identity':
                return subprocess.CompletedProcess(command,0,json.dumps({'model_id':model,'embedding_identity':identity,'identity_sha256':'c'*64}),b'')
            record=local_record()['record']
            record['outcome']['corpus_identity']['embedding']=identity
            Path(command[command.index('--output')+1]).write_text(json.dumps(record)+'\n')
            return subprocess.CompletedProcess(command,0,b'',b'')
        with patch.dict(os.environ,self.env),patch.object(self.prepare.provider,'_execute',side_effect=execute):
            manifest=self.prepare.prepare({'schema_version':1,'execution_id':'fresh-test-execution','tests':[{'vars':variables}]},self.root/'prepared-browser.json')
        self.assertEqual(seen[0][2],'embedding-identity')
        self.assertIn('--embedding-model',seen[1])
        pin=manifest['embedding_manifest']
        raw=Path(pin['path']).read_bytes()
        import hashlib
        self.assertEqual(hashlib.sha256(raw).hexdigest(),pin['sha256'])
        self.assertEqual(json.loads(raw)['models'][model],identity)

if __name__=='__main__':unittest.main()
