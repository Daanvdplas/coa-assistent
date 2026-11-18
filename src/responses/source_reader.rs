//! Explicit full-source reads for the web agent; ranking alone is not a catalog scan.
use super::{
    DemoSearchMethod, MAX_SEARCHES, ToolCall,
    rig_runtime::{BoundaryError, RecordedSearch, RunState, validate_search_goal},
};
use crate::corpus::CorpusId;
use rig::tool::{Tool, ToolContext};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadArguments {
    source_ids: Vec<String>,
    search_goal: String,
}

pub(super) struct ReadSourcesTool {
    pub corpus: CorpusId,
    pub method: DemoSearchMethod,
    pub state: Arc<Mutex<RunState>>,
}

impl ReadSourcesTool {
    fn execute(&self, arguments: ReadArguments) -> Result<Value, BoundaryError> {
        let result = self.execute_inner(arguments);
        if let Err(error) = &result
            && let Ok(mut state) = self.state.lock()
        {
            state.error = Some(error.0);
        }
        result
    }

    fn execute_inner(&self, arguments: ReadArguments) -> Result<Value, BoundaryError> {
        validate_search_goal(&arguments.search_goal)?;
        let selected: HashSet<_> = arguments.source_ids.iter().map(String::as_str).collect();
        if selected.is_empty()
            || selected.len() > 12
            || selected.len() != arguments.source_ids.len()
        {
            return Err(BoundaryError(
                "tool: Kies één tot twaalf verschillende bron-ID's.",
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| BoundaryError("runtime: De uitvoering is niet beschikbaar."))?;
        let seed = state
            .calls
            .first()
            .filter(|call| call.call.tool == "search_document")
            .and_then(|call| call.call.result.as_ref())
            .ok_or(BoundaryError("tool: Zoek eerst in de activiteitbronnen."))?;
        if state.calls.len() >= MAX_SEARCHES {
            return Err(BoundaryError(
                "tool: Alleen maximaal vier bronzoekacties zijn toegestaan.",
            ));
        }
        let sources = self
            .corpus
            .sources()
            .map_err(|_| BoundaryError("tool: De activiteitbronnen zijn niet beschikbaar."))?;
        let catalog: Vec<_> = sources.iter().zip(self.corpus.documents()).map(|(source, text)| {
            json!({"id":source.id,"title":source.title,"date":source.date,"sha256":crate::manifest::hash(text.as_bytes())})
        }).collect();
        if seed["sources"] != json!(catalog)
            || seed["as_of"] != self.corpus.as_of()
            || seed["manifest"]["source_sha256"] != self.corpus.sha256()
            || seed["retrieval_method"] != json!(self.method)
        {
            return Err(BoundaryError("tool: De bronverzameling is veranderd."));
        }
        if selected
            .iter()
            .any(|id| !sources.iter().any(|source| source.id == *id))
        {
            return Err(BoundaryError("tool: Onbekende bron-ID."));
        }
        let chosen: Vec<_> = sources
            .iter()
            .filter(|source| selected.contains(source.id.as_str()))
            .collect();
        let ids: Vec<_> = chosen.iter().map(|source| source.id.clone()).collect();
        let hits: Vec<_> = chosen
            .iter()
            .flat_map(|source| source.sections.iter())
            .map(|section| json!({"section":section}))
            .collect();
        let result = json!({"operation":"read_sources","ranked":false,"read_source_ids":ids,"corpus_complete":chosen.len() == sources.len(),"sources":seed["sources"],"as_of":seed["as_of"],"manifest":seed["manifest"],"retrieval_method":self.method,"hits":hits});
        state.calls.push(RecordedSearch {
            search_goal: arguments.search_goal,
            call: ToolCall {
                server: "local".into(),
                tool: Self::NAME.into(),
                query: chosen
                    .iter()
                    .map(|source| source.title.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                top_k: 0, // An explicit read has no ranked top-k selection.
                status: "completed".into(),
                result: Some(result.clone()),
                error: None,
            },
        });
        Ok(result)
    }
}

impl Tool for ReadSourcesTool {
    const NAME: &'static str = "read_sources";
    type Args = ReadArguments;
    type Output = Value;
    type Error = BoundaryError;

    fn description(&self) -> String {
        "Read every original section of selected activity sources from the catalog returned by search_document. Use this when ranked hits alone do not establish the requested facts or a complete comparison. Request only catalog source IDs, at most twelve in one call. A read counts toward the shared four source actions. Supply a short public information-seeking search_goal in the answer language, never private reasoning or conclusions.".into()
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"source_ids":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":12},"search_goal":{"type":"string","minLength":1,"maxLength":80}},"required":["source_ids","search_goal"],"additionalProperties":false})
    }
    async fn call(
        &self,
        _: &mut ToolContext,
        arguments: ReadArguments,
    ) -> Result<Value, BoundaryError> {
        self.execute(arguments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::responses::tests::corpus_evidence;

    fn reader(corpus: CorpusId) -> ReadSourcesTool {
        let state = Arc::new(Mutex::new(RunState::default()));
        state.lock().unwrap().calls.push(RecordedSearch {
            search_goal: "Tijden opzoeken".into(),
            call: ToolCall {
                server: "local".into(),
                tool: "search_document".into(),
                query: "14.00 uur".into(),
                top_k: 3,
                status: "completed".into(),
                result: Some(corpus_evidence(corpus)),
                error: None,
            },
        });
        ReadSourcesTool {
            corpus,
            method: DemoSearchMethod::Bm25,
            state,
        }
    }

    fn arguments(ids: &[&str]) -> ReadArguments {
        ReadArguments {
            source_ids: ids.iter().map(|id| (*id).into()).collect(),
            search_goal: "Activiteiten bekijken".into(),
        }
    }

    #[test]
    fn reads_require_a_prior_search_and_known_distinct_ids_from_the_same_corpus() {
        for ids in [
            vec![],
            vec!["ACT-FIETS-002", "ACT-FIETS-002"],
            vec!["/etc/passwd"],
            vec!["https://example.com"],
            vec!["ACT-FIETS-002", "UNKNOWN"],
        ] {
            let tool = reader(CorpusId::DemoTwelve);
            assert!(tool.execute(arguments(&ids)).is_err());
            assert_eq!(tool.state.lock().unwrap().calls.len(), 1);
        }
        let tool = reader(CorpusId::DemoTwelve);
        let too_many: Vec<_> = (0..13).map(|id| format!("SOURCE-{id}")).collect();
        assert!(
            tool.execute(ReadArguments {
                source_ids: too_many,
                search_goal: "Bronnen bekijken".into()
            })
            .is_err()
        );
        let tool = reader(CorpusId::DemoTwelve);
        tool.state.lock().unwrap().calls.clear();
        assert!(tool.execute(arguments(&["ACT-FIETS-002"])).is_err());
        let mut tool = reader(CorpusId::DemoTwelve);
        tool.corpus = CorpusId::BaselineFive;
        assert!(tool.execute(arguments(&["ACT-FIETS-002"])).is_err());
        let tool = reader(CorpusId::DemoTwelve);
        tool.state.lock().unwrap().calls[0]
            .call
            .result
            .as_mut()
            .unwrap()["sources"][0]["sha256"] = json!("changed");
        assert!(tool.execute(arguments(&["ACT-FIETS-002"])).is_err());
    }

    #[test]
    fn explicit_subset_reads_return_only_the_selected_source_and_share_the_four_action_limit() {
        let tool = reader(CorpusId::DemoTwelve);
        for _ in 0..3 {
            let result = tool.execute(arguments(&["ACT-FIETS-002"])).unwrap();
            assert_eq!(result["hits"].as_array().unwrap().len(), 6);
            assert_eq!(result["corpus_complete"], false);
            assert!(
                result["hits"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|hit| hit["section"]["source_id"] == "ACT-FIETS-002")
            );
            assert_eq!(
                result["manifest"],
                corpus_evidence(CorpusId::DemoTwelve)["manifest"]
            );
        }
        assert_eq!(tool.state.lock().unwrap().calls.len(), 4);
        assert!(tool.execute(arguments(&["ACT-TAAL-003"])).is_err());
        assert_eq!(tool.state.lock().unwrap().calls.len(), 4);
    }
}
