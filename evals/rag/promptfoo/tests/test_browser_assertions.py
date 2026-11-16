"""Browser runs bind their actual embedding model to independent preparation."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_assertions import HERE, local_record, load_assertions
from test_provider import load_provider
from test_environment import isolate_runtime_environment

class BrowserAssertionsTest(unittest.TestCase):
    def setUp(self):
        isolate_runtime_environment(self)
        self.assertions=load_assertions()
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.spec=next(row for row in json.loads((HERE.parent/'embedding-models.json').read_text()) if row['id']=='e5-small-multilingual')
        self.identity={'provider':'local-fastembed','model':self.spec['repository']+'@'+'a'*40,'sdk':self.spec['sdk'],'dimensions':384,'encoding':self.spec['encoding']+'; model_files_sha256='+'b'*64,'document_prefix':'passage: ','query_prefix':'query: '}
        self.envelope=local_record()
        record=self.envelope['record']
        record['config']['retrieval']['top_k']=5;record['outcome']['config']['top_k']=5
        corpus=record['outcome']['corpus_identity']
        inputs=['passage: '+section['source_title']+'\n'+section['heading']+'\n'+section['text'] for section in self.assertions.canonical_sources().values()]
        corpus['embedding_inputs_sha256']=hashlib.sha256(self.assertions._json_bytes(inputs)).hexdigest()
        corpus['embedding']=copy.deepcopy(self.identity)
        record['preparation']['corpus_identity']=copy.deepcopy(corpus)
        self.variables={**load_provider().DEFAULTS,'mode':'local','method':'dense','top_k':5,'filters':{},'dataset':'legacy','case_id':'P01','question':self.envelope['question'],'browser_eval_id':'garden-time-location','embedding_model':'e5-small-multilingual'}
        manifest=self.root/'embedding.json'
        manifest.write_text(json.dumps({'schema_version':1,'execution_id':'browser-test','models':{'e5-small-multilingual':self.identity}}))
        self.env={'COA_PROMPTFOO_ARTIFACT_DIR':str(self.root),'COA_PROMPTFOO_EXECUTION_ID':'browser-test','COA_PROMPTFOO_EMBEDDING_MANIFEST':str(manifest),'COA_PROMPTFOO_EMBEDDING_MANIFEST_SHA256':hashlib.sha256(manifest.read_bytes()).hexdigest()}

    def grade(self,envelope=None):
        with patch.dict(os.environ,self.env):
            return self.assertions.get_assert(envelope or self.envelope,{'vars':self.variables})

    def test_true_e5_identity_and_prefixed_corpus_have_source_goal_details(self):
        grade=self.grade()
        self.assertTrue(grade['pass'])
        metrics=grade['metadata']['source_metrics']
        self.assertEqual(metrics['embedding_identity'],self.identity)
        self.assertEqual(len(metrics['goals']),2)
        self.assertTrue(all(goal['covered'] for goal in metrics['goals']))
        self.assertTrue(all(ref['found'] for goal in metrics['goals'] for option in goal['alternatives'] for ref in option))

    def test_model_revision_artifact_prefix_sdk_or_dimensions_cannot_be_substituted(self):
        changes={'model':self.spec['repository']+'@'+'c'*40,'encoding':self.spec['encoding']+'; model_files_sha256='+'c'*64,'document_prefix':'','query_prefix':'','sdk':'other','dimensions':768}
        for field,value in changes.items():
            with self.subTest(field=field):
                row=copy.deepcopy(self.envelope)
                row['record']['outcome']['corpus_identity']['embedding'][field]=value
                row['record']['preparation']['corpus_identity']['embedding'][field]=value
                grade=self.grade(row)
                self.assertFalse(grade['pass']);self.assertEqual(grade['namedScores']['execution_integrity'],0)

    def test_unprefixed_inputs_or_changed_independent_model_pin_fail(self):
        row=copy.deepcopy(self.envelope)
        row['record']['outcome']['corpus_identity']['embedding_inputs_sha256']='0'*64
        row['record']['preparation']['corpus_identity']['embedding_inputs_sha256']='0'*64
        self.assertFalse(self.grade(row)['pass'])
        self.env['COA_PROMPTFOO_EMBEDDING_MANIFEST_SHA256']='0'*64
        grade=self.grade();self.assertFalse(grade['pass']);self.assertEqual(grade['namedScores']['execution_integrity'],0)

    def test_word_only_run_has_no_actual_embedding_and_cannot_relabel_vectors_as_unused(self):
        self.variables['method']='bm25'
        record=self.envelope['record']
        record['config']['retrieval']['method']='bm25';record['outcome']['config']['method']='bm25'
        corpus=record['outcome']['corpus_identity']
        corpus['embedding']=None;corpus['vectors_sha256']=None
        inputs=[section['source_title']+'\n'+section['heading']+'\n'+section['text'] for section in self.assertions.canonical_sources().values()]
        corpus['embedding_inputs_sha256']=hashlib.sha256(self.assertions._json_bytes(inputs)).hexdigest()
        record['preparation']['corpus_identity']=copy.deepcopy(corpus)
        for candidate in record['outcome']['candidates']:
            scores=candidate['scores'];scores['bm25_score']=scores['dense_similarity'];scores['keyword_rank']=scores['dense_rank'];scores['dense_similarity']=None;scores['dense_rank']=None
        for hit,candidate in zip(record['outcome']['hits'],record['outcome']['candidates']):hit['scores']=copy.deepcopy(candidate['scores'])
        grade=self.grade();self.assertTrue(grade['pass'])
        self.assertIsNone(grade['metadata']['source_metrics']['embedding_identity'])
        corpus['embedding']=self.identity;record['preparation']['corpus_identity']['embedding']=self.identity
        grade=self.grade();self.assertFalse(grade['pass']);self.assertEqual(grade['namedScores']['execution_integrity'],0)

if __name__=='__main__':unittest.main()
