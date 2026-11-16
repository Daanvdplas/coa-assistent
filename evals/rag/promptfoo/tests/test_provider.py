"""Provider boundary checks: no cloud key, gold leak, implicit live run or retry."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_assertions import HERE, local_record


def load_provider():
    path=HERE/'provider.py'
    if not path.exists():return None
    spec=importlib.util.spec_from_file_location('coa_rag_provider',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


class ProviderTest(unittest.TestCase):
    def setUp(self):
        self.provider=load_provider()
        self.assertIsNotNone(self.provider,'Promptfoo provider is not implemented')
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name)
        binary=self.directory/'runtime';binary.write_text('#!/usr/bin/env python3\n');binary.chmod(0o700)
        self.env={'COA_RAG_BINARY':str(binary),'COA_PROMPTFOO_ARTIFACT_DIR':str(self.directory/'artifacts'),'OPENAI_API_KEY':'key-must-not-leak','COA_OPENAI_API_KEY_FILE':'/key/must/not/open'}
        self.record=local_record()['record']
        self.context={'vars':{'dataset':'legacy','case_id':'P01','question':self.record['question'],'expected':'GOLD-MUST-NOT-LEAK'}}

    def test_one_real_execution_contract_forwards_only_input_and_scrubs_api_keys(self):
        observed=[]
        def run(command, env, timeout, cwd):
            observed.append((command,env))
            output=Path(command[command.index('--output')+1]);output.write_text(json.dumps(self.record)+'\n')
            return subprocess.CompletedProcess(command,0,b'{}',b'')
        with patch.dict(os.environ,self.env,clear=False),patch.object(self.provider,'_execute',side_effect=run):
            response=self.provider.call_api('GOLD-IN-PROMPT-MUST-NOT-LEAK',{'config':{'mode':'local','method':'bm25','profile':'documents_sections'}},self.context)
        self.assertNotIn('error',response)
        self.assertEqual(response['output']['case_id'],'P01')
        self.assertEqual(response['metadata']['run_id'],'measured-run-one')
        self.assertEqual(len(observed),1)
        command,env=observed[0]
        self.assertNotIn('OPENAI_API_KEY',env);self.assertNotIn('COA_OPENAI_API_KEY_FILE',env)
        self.assertNotIn('GOLD',' '.join(command));self.assertNotIn('assess',command)
        self.assertEqual(command.count('--cases'),1)

    def test_codex_needs_explicit_live_opt_in_before_process_start(self):
        with patch.dict(os.environ,self.env,clear=False),patch.object(self.provider,'_execute') as execute:
            response=self.provider.call_api('',{'config':{'mode':'codex','model':'gpt-6.1-sol'}},self.context)
        self.assertIn('error',response);self.assertEqual(execute.call_count,0)

    def test_runtime_failure_does_not_retry_or_export_stderr(self):
        failed=subprocess.CompletedProcess([],1,b'',b'private reasoning and sk-secret')
        with patch.dict(os.environ,self.env,clear=False),patch.object(self.provider,'_execute',return_value=failed) as execute:
            response=self.provider.call_api('',{'config':{'mode':'local','method':'bm25','profile':'documents_sections'}},self.context)
        self.assertIn('error',response);self.assertEqual(execute.call_count,1)
        self.assertNotIn('sk-secret',json.dumps(response));self.assertNotIn('reasoning',json.dumps(response))

    def test_browser_embedding_model_reaches_native_retrieval_and_partitions_preparation_keys(self):
        self.context['vars'].update(browser_eval_id='garden-time-location',embedding_model='e5-small-multilingual',method='dense',top_k=5)
        commands=[]
        def run(command,env,timeout,cwd):
            commands.append(command)
            Path(command[command.index('--output')+1]).write_text(json.dumps(self.record)+'\n')
            return subprocess.CompletedProcess(command,0,b'',b'')
        with patch.dict(os.environ,self.env),patch.object(self.provider,'_execute',side_effect=run):
            result=self.provider.call_api('',{},self.context)
        self.assertNotIn('error',result)
        self.assertIn('--embedding-model',commands[0])
        self.assertEqual(commands[0][commands[0].index('--embedding-model')+1],'e5-small-multilingual')
        first=self.provider.request_key(self.context['vars'])
        other={**self.context['vars'],'embedding_model':'minilm-multilingual'}
        self.assertNotEqual(first,self.provider.request_key(other))

    def test_embedding_override_is_rejected_outside_the_browser_route(self):
        self.context['vars']['embedding_model']='e5-small-multilingual'
        with patch.dict(os.environ,self.env),patch.object(self.provider,'_execute') as execute:
            result=self.provider.call_api('',{},self.context)
        self.assertIn('error',result);self.assertEqual(execute.call_count,0)

    def test_browser_search_cannot_be_switched_to_codex_through_provider_options(self):
        self.context['vars'].update(browser_eval_id='garden-time-location',embedding_model='e5-small-multilingual',top_k=5)
        with patch.dict(os.environ,self.env),patch.object(self.provider,'_reserve',side_effect=ValueError('No models allowed in search tests')) as reserve,patch.object(self.provider,'_execute') as execute:
            result=self.provider.call_api('',{'config':{'mode':'codex'}},self.context)
        self.assertIn('error',result);self.assertEqual(reserve.call_count,0);self.assertEqual(execute.call_count,0)

if __name__=='__main__':unittest.main()
