//! Display completed native evidence while the existing grader is still running.
use meedoen_retrieval::{
    retrieval::{PreparedCorpus, RetrievalConfig, SearchMethod},
    retrieval_lab::{
        catalog,
        embedding_models::ModelChoice,
        reference::ExpectationsContext,
        types::{ExecutionKind, ExecutionStatus, RetrievalRecord, RunConfig},
    },
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
};

const MAX_CAPTURE: u64 = 64 * 1024 * 1024;

fn bounded_json(path: &Path) -> Option<Value> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CAPTURE {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn local_file(directory: &Path, value: &Value) -> Option<PathBuf> {
    let relative = Path::new(value.as_str()?);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let path = directory.join(relative);
    if !path
        .canonicalize()
        .ok()?
        .starts_with(directory.canonicalize().ok()?)
    {
        return None;
    }
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    (metadata.is_file() && metadata.len() <= MAX_CAPTURE).then_some(path)
}

fn project(
    snapshot: &Value,
    descriptor: &Value,
    request: &Value,
    record: RetrievalRecord,
    manifest: &Value,
    context: &ExpectationsContext,
) -> Option<(Value, serde_json::Map<String, Value>)> {
    meedoen_retrieval::retrieval_lab::records::validate_record(&record).ok()?;
    let execution = descriptor["execution_id"].as_str()?;
    let request_id = request["request_id"].as_str()?;
    let case = context
        .dataset
        .catalog
        .cases
        .iter()
        .find(|case| case.id == descriptor["case_id"])?;
    let corpus = context.dataset.corpus();
    let repeat = request["repeat"].as_u64()?;
    let group = snapshot["plan"]["groups"]
        .as_array()?
        .iter()
        .find(|group| group["id"] == request["group_id"] && group["kind"] == "local")?;
    let configuration = group["configurations"]
        .as_array()?
        .iter()
        .find(|configuration| configuration["id"] == request["configuration_id"])?;
    let planned = &configuration["configuration"];
    let comparison = format!(
        "{}:{}:{}:{repeat}",
        group["id"].as_str()?,
        case.id,
        configuration["id"].as_str()?
    );
    if request_id.len() != 64
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || repeat == 0
        || repeat
            > snapshot["plan"]["selection"]["repeats"]
                .as_u64()
                .unwrap_or(0)
        || request["comparison_key"] != comparison
        || group["dataset"] != descriptor["dataset"]
        || group["identity"]["corpus_sha256"] != corpus.sha256()
        || descriptor["corpus_sha256"] != corpus.sha256()
        || descriptor["as_of"] != corpus.as_of()
        || descriptor["question"] != case.question
        || request["vars"]["question"] != case.question
        || request["vars"]["case_id"] != case.id
        || request["vars"]["dataset"] != descriptor["dataset"]
        || record.dataset != context.dataset.catalog.identity
        || record.case_id != case.id
        || record.question != case.question
        || record.schema_version != 1
        || record.execution_kind != ExecutionKind::LocalMeasured
        || !matches!(
            record.execution_status,
            ExecutionStatus::Completed | ExecutionStatus::Failed
        )
        || !record.batch_id.starts_with(&format!("{execution}-native-"))
        || record.run_id != format!("{}--{request_id}", record.batch_id)
        || record.request_filters
            != context
                .dataset
                .query_inputs
                .get(&case.id)
                .cloned()
                .unwrap_or_default()
    {
        return None;
    }
    let mut retrieval = serde_json::to_value(RetrievalConfig::default()).ok()?;
    for (key, value) in retrieval.as_object_mut()? {
        if let Some(selected) = planned.get(key) {
            *value = selected.clone();
        }
    }
    let expected = RunConfig {
        profile: serde_json::from_value(planned["profile"].clone()).ok()?,
        retrieval: serde_json::from_value(retrieval).ok()?,
    };
    if record.config != expected || record.config_id != catalog::config_id(&expected).ok()? {
        return None;
    }
    if expected.retrieval.method == SearchMethod::Bm25 {
        if !request["embedding_model"].is_null() {
            return None;
        }
    } else {
        let model = request["embedding_model"]
            .as_str()?
            .parse::<ModelChoice>()
            .ok()?;
        if model.id()
            != planned["embedding_model"]
                .as_str()
                .unwrap_or("minilm-multilingual")
        {
            return None;
        }
    }
    if record.execution_status == ExecutionStatus::Failed {
        // Native errors can contain private paths. An attempted failure is
        // visible, but supplies no invented evidence, model identity or grade.
        return Some((
            json!({"id":record.run_id,"native_run_id":record.run_id,"native_capture":true,"execution_status":"failed","status":"error","reason":"De lokale zoekactie is mislukt; bronbewijs is niet beoordeeld.","execution_origin":"native_capture","dataset":descriptor["dataset"],"case_id":case.id,"question":case.question,"suite":group["suite"],"group_id":group["id"],"configuration_id":configuration["id"],"configuration":planned,"repeat":repeat,"comparison_key":comparison,"source_complete":null,"metrics":{"covered_goals":null,"target_goals":null,"goal_coverage":null,"source_quality_applicable":null},"goals":[],"assertions":[],"calls":[],"corpus_identity":null,"embedding_identity":null,"retrieval_ms":record.timings.retrieval_ms,"rag_timing":{"scope":"prepared_index_query","query_total_ms":record.timings.query_total_ms,"query_embedding_ms":record.timings.query_embedding_ms,"query_embedding_cache_hit":record.timings.query_embedding_cache_hit,"ranking_ms":record.timings.retrieval_ms},"rag_preparation":record.preparation,"promptfoo_ms":null,"native_elapsed_ms":null,"answer":null}),
            serde_json::Map::new(),
        ));
    }
    let outcome = record.outcome.as_ref()?;
    if record.preparation.corpus_identity.as_ref() != Some(&outcome.corpus_identity) {
        return None;
    }
    let source = PreparedCorpus::new(
        corpus
            .sources()
            .ok()?
            .into_iter()
            .flat_map(|source| source.sections)
            .collect(),
        None,
        None,
    )
    .ok()?;
    if outcome.corpus_identity.source_sha256 != source.identity.source_sha256 {
        return None;
    }
    if expected.retrieval.method == SearchMethod::Bm25 {
        if !request["embedding_model"].is_null() || outcome.corpus_identity.embedding.is_some() {
            return None;
        }
    } else {
        let model = request["embedding_model"]
            .as_str()?
            .parse::<ModelChoice>()
            .ok()?;
        let embedding = outcome.corpus_identity.embedding.as_ref()?;
        let expected_model = planned["embedding_model"]
            .as_str()
            .unwrap_or("minilm-multilingual");
        if model.id() != expected_model
            || serde_json::to_value(embedding).ok()? != manifest["models"][model.id()]
            || embedding.document_prefix != model.spec().document_prefix
            || embedding.query_prefix != model.spec().query_prefix
            || embedding.dimensions != model.spec().dimensions
            || embedding.sdk != model.spec().sdk
            || !embedding
                .model
                .starts_with(&format!("{}@", model.spec().repository))
        {
            return None;
        }
    }
    let goals: Vec<_> = context.criteria.get(&case.id)?.facts.iter().map(|fact| json!({
        "id":fact.id,"description":fact.description,"covered":null,
        "alternatives":fact.evidence_alternatives.iter().map(|alternative| alternative.iter().map(|reference| json!({"source_id":reference.source_id,"section_id":reference.section_id,"found":null})).collect::<Vec<_>>()).collect::<Vec<_>>()
    })).collect();
    let mut sources = serde_json::Map::new();
    let mut hits = Vec::new();
    for hit in &outcome.hits {
        let key = format!(
            "captured:{}:{}:{}",
            record.run_id, hit.section.source_id, hit.section.id
        );
        sources.insert(key.clone(), serde_json::to_value(&hit.section).ok()?);
        hits.push(key);
    }
    let row = json!({"id":record.run_id,"native_run_id":record.run_id,"native_capture":true,"execution_status":"completed","status":"retrieved_ungraded","reason":"Opgehaald, nog niet beoordeeld","execution_origin":"native_capture","dataset":descriptor["dataset"],"case_id":case.id,"question":case.question,"suite":group["suite"],"group_id":group["id"],"configuration_id":configuration["id"],"configuration":planned,"repeat":repeat,"comparison_key":comparison,"source_complete":null,"metrics":{"covered_goals":null,"target_goals":goals.len(),"goal_coverage":null,"source_quality_applicable":null},"goals":goals,"assertions":[],"calls":[{"status":"completed","hits":hits}],"corpus_identity":outcome.corpus_identity,"embedding_identity":outcome.corpus_identity.embedding,"retrieval_ms":record.timings.retrieval_ms,"rag_timing":{"scope":"prepared_index_query","query_total_ms":record.timings.query_total_ms,"query_embedding_ms":record.timings.query_embedding_ms,"query_embedding_cache_hit":record.timings.query_embedding_cache_hit,"ranking_ms":record.timings.retrieval_ms},"rag_preparation":record.preparation,"promptfoo_ms":null,"native_elapsed_ms":null,"answer":null});
    Some((row, sources))
}

pub(super) fn merge(snapshot: &mut Value, directory: &Path, previous: &Value) {
    let mut additions = Vec::new();
    let mut sources = serde_json::Map::new();
    for row in previous["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["native_capture"] == true)
    {
        additions.push(row.clone());
    }
    if !additions.is_empty() {
        sources.extend(previous["sources"].as_object().cloned().unwrap_or_default());
    }
    if let Some(descriptor) = bounded_json(&directory.join("active-native-capture.json")) {
        let captured = (|| {
            if descriptor["schema_version"] != 1 {
                return None;
            }
            let dataset = descriptor["dataset"].as_str()?;
            if !["demo-12-20261118", "regression-12-20261118"].contains(&dataset) {
                return None;
            }
            let context = ExpectationsContext::load(dataset).ok()?;
            let manifest =
                bounded_json(&local_file(directory, &descriptor["embedding_manifest"])?)?;
            if manifest["schema_version"] != 1
                || manifest["execution_id"] != descriptor["execution_id"]
            {
                return None;
            }
            let native =
                std::fs::read_to_string(local_file(directory, &descriptor["native_path"])?).ok()?;
            let mut seen = BTreeSet::new();
            for line in native
                .split_inclusive('\n')
                .filter(|line| line.ends_with('\n'))
            {
                let Ok(value) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let Some(request) = descriptor["requests"]
                    .as_array()?
                    .iter()
                    .find(|request| request["request_id"] == value["request_id"])
                else {
                    continue;
                };
                if !seen.insert(value["request_id"].as_str()?.to_owned()) {
                    continue;
                }
                let Ok(record) = serde_json::from_value::<RetrievalRecord>(value["record"].clone())
                else {
                    continue;
                };
                if let Some((row, payloads)) =
                    project(snapshot, &descriptor, request, record, &manifest, &context)
                {
                    additions.push(row);
                    sources.extend(payloads);
                }
            }
            Some(())
        })();
        let _ = captured;
    }
    let Some(rows) = snapshot["result"]["rows"].as_array_mut() else {
        return;
    };
    for row in additions {
        if !rows
            .iter()
            .any(|existing| existing["comparison_key"] == row["comparison_key"])
        {
            rows.push(row);
        }
    }
    let captured = rows
        .iter()
        .filter(|row| row["native_capture"] == true)
        .count();
    snapshot["progress"]["native_captured"] = json!(captured);
    if let Some(existing) = snapshot["result"]["sources"].as_object_mut() {
        existing.extend(sources);
    }
}
