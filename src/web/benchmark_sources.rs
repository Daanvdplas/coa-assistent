//! Display-only coverage of unique required sections in actual offered payloads.
//! Protected goal flags and expected-text hydration are never retrieval evidence.
use meedoen_retrieval::{Section, corpus::CorpusId};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

type Reference = (String, String);
type Proof = BTreeSet<Reference>;
const MAX_PROOFS: usize = 4096;

struct Requirements {
    proofs: Vec<Proof>,
    has_alternatives: bool,
}
struct CanonicalCorpus {
    sections: BTreeMap<Reference, Section>,
    prepared_source_sha256: String,
}

fn unknown(applicable: Value, has_alternatives: bool) -> Value {
    json!({"found":null,"total":null,"unit":"sections","found_refs":[],"missing_refs":[],"has_alternatives":has_alternatives,"documents":{"found":null,"total":null},"applicable":applicable})
}

fn reference(value: &Value) -> Option<Reference> {
    let source = value["source_id"].as_str().filter(|id| !id.is_empty())?;
    let section = value["section_id"].as_str().filter(|id| !id.is_empty())?;
    Some((source.into(), section.into()))
}

// A goal is AND within one alternative and OR between alternatives. Deduplicate
// shared sections across goals; a superset never supplies a smaller proof.
fn requirements(row: &Value) -> Result<Option<Requirements>, ()> {
    let goals = row["goals"].as_array().ok_or(())?;
    let mut proofs = vec![Proof::new()];
    let mut has_alternatives = false;
    let mut positive = false;
    for goal in goals {
        let alternatives = goal["alternatives"].as_array().ok_or(())?;
        if alternatives.is_empty() {
            continue;
        }
        positive = true;
        let alternatives: BTreeSet<Proof> = alternatives
            .iter()
            .map(|alternative| {
                let values = alternative
                    .as_array()
                    .filter(|values| !values.is_empty())
                    .ok_or(())?;
                values
                    .iter()
                    .map(|value| reference(value).ok_or(()))
                    .collect()
            })
            .collect::<Result<_, ()>>()?;
        has_alternatives |= alternatives.len() > 1;
        let mut next = BTreeSet::new();
        for proof in &proofs {
            for alternative in &alternatives {
                next.insert(proof.union(alternative).cloned().collect::<Proof>());
                if next.len() > MAX_PROOFS {
                    return Err(());
                }
            }
        }
        let mut next: Vec<_> = next.into_iter().collect();
        next.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
        let mut minimal: Vec<Proof> = Vec::new();
        for candidate in next {
            if !minimal.iter().any(|proof| proof.is_subset(&candidate)) {
                minimal.push(candidate);
            }
        }
        proofs = minimal;
    }
    Ok(positive.then_some(Requirements {
        proofs,
        has_alternatives,
    }))
}

fn canonical_corpora() -> BTreeMap<String, CanonicalCorpus> {
    [
        CorpusId::BaselineFive,
        CorpusId::ExpandedTen,
        CorpusId::DemoTwelve,
    ]
    .into_iter()
    .filter_map(|corpus| {
        let sections: Vec<_> = corpus
            .sources()
            .ok()?
            .into_iter()
            .flat_map(|source| source.sections)
            .collect();
        let prepared =
            meedoen_retrieval::retrieval::PreparedCorpus::new(sections, None, None).ok()?;
        Some((
            corpus.sha256(),
            CanonicalCorpus {
                prepared_source_sha256: prepared.identity.source_sha256,
                sections: prepared
                    .sections
                    .into_iter()
                    .map(|section| ((section.source_id.clone(), section.id.clone()), section))
                    .collect(),
            },
        ))
    })
    .collect()
}

fn actual_hash_matches(row: &Value, document_hash: &str, section_hash: &str) -> bool {
    // PreparedCorpus hashes serialized canonical sections; Manifest hashes raw
    // documents. Bind each representation separately without changing evidence.
    [
        ("/corpus_identity/source_sha256", section_hash),
        ("/manifest/source_sha256", document_hash),
        ("/manifest/corpus_sha256", document_hash),
        ("/source_manifest/corpus_sha256", document_hash),
        ("/corpus_sha256", document_hash),
    ]
    .into_iter()
    .filter_map(|(path, expected)| {
        row.pointer(path)
            .filter(|value| !value.is_null())
            .map(|value| (value, expected))
    })
    .all(|(value, expected)| value.as_str() == Some(expected))
}

fn offered(
    row: &Value,
    sources: &Map<String, Value>,
    required: &Proof,
    canonical: &BTreeMap<Reference, Section>,
) -> Option<Proof> {
    let calls = row["calls"].as_array()?;
    let mut found = Proof::new();
    for call in calls {
        if call["status"]
            .as_str()
            .is_some_and(|status| status != "completed")
        {
            continue;
        }
        for key in call["hits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if key.starts_with("expected:") {
                continue;
            }
            let Some(payload) = sources.get(key) else {
                continue;
            };
            let payload = payload.get("section").unwrap_or(payload);
            let Some(text) = payload["text"].as_str().filter(|text| !text.is_empty()) else {
                continue;
            };
            for id in required {
                let section = &canonical[id];
                // Full activity text can supply several required sections. Only
                // actual text from this call counts, never canonical backfill.
                if payload["source_id"] == section.source_id
                    && payload["source_date"] == section.source_date
                    && text.contains(&section.text)
                {
                    found.insert(id.clone());
                }
            }
        }
    }
    Some(found)
}

fn projection(
    row: &Value,
    sources: &Map<String, Value>,
    identity: Option<&str>,
    corpora: &BTreeMap<String, CanonicalCorpus>,
) -> Value {
    if matches!(
        row["status"].as_str(),
        Some(
            "error"
                | "failed_execution"
                | "not_run"
                | "queued"
                | "running"
                | "preparing"
                | "cancelled"
                | "interrupted"
        )
    ) {
        return unknown(Value::Null, false);
    }
    if row["metrics"]["source_quality_applicable"] == false {
        return unknown(json!(false), false);
    }
    let required = match requirements(row) {
        Ok(Some(required)) => required,
        Ok(None) => return unknown(json!(false), false),
        Err(()) => return unknown(Value::Null, false),
    };
    let unassessed = || unknown(Value::Null, required.has_alternatives);
    if matches!(
        row["status"].as_str(),
        Some("not_run" | "queued" | "running" | "preparing" | "cancelled" | "interrupted")
    ) {
        return unassessed();
    }
    let Some(identity) = identity else {
        return unassessed();
    };
    let Some(corpus) = corpora.get(identity) else {
        return unassessed();
    };
    if !actual_hash_matches(row, identity, &corpus.prepared_source_sha256) {
        return unassessed();
    }
    let canonical = &corpus.sections;
    let proofs: Vec<_> = required
        .proofs
        .iter()
        .filter(|proof| proof.iter().all(|id| canonical.contains_key(id)))
        .collect();
    let all: Proof = proofs
        .iter()
        .flat_map(|proof| proof.iter().cloned())
        .collect();
    let Some(found) = offered(row, sources, &all, canonical) else {
        return unassessed();
    };
    // Prefer a completed proof. Otherwise use the most complete valid route,
    // then the smaller requirement set, with stable ordering for equal routes.
    let Some(best) = proofs.into_iter().max_by(|a, b| {
        let a_found = a.intersection(&found).count();
        let b_found = b.intersection(&found).count();
        (a_found == a.len())
            .cmp(&(b_found == b.len()))
            .then_with(|| (a_found * b.len()).cmp(&(b_found * a.len())))
            .then_with(|| b.len().cmp(&a.len()))
            .then_with(|| b.cmp(a))
    }) else {
        return unassessed();
    };
    let found_refs: Vec<_> = best
        .intersection(&found)
        .map(|(source, section)| json!({"source_id":source,"section_id":section}))
        .collect();
    let missing_refs: Vec<_> = best
        .difference(&found)
        .map(|(source, section)| json!({"source_id":source,"section_id":section}))
        .collect();
    let documents: BTreeSet<_> = best.iter().map(|(source, _)| source).collect();
    let found_documents: BTreeSet<_> = best
        .intersection(&found)
        .map(|(source, _)| source)
        .collect();
    json!({"found":found_refs.len(),"total":best.len(),"unit":"sections","found_refs":found_refs,"missing_refs":missing_refs,"has_alternatives":required.has_alternatives,"documents":{"found":found_documents.len(),"total":documents.len()},"applicable":true})
}

fn actual_retrieval(
    row: &Value,
    sources: &Map<String, Value>,
    identity: Option<&str>,
    corpora: &BTreeMap<String, CanonicalCorpus>,
) -> Value {
    let unknown = || json!({"activities":null,"sections":null,"applicable":null});
    if !matches!(
        row["status"].as_str(),
        Some("passed" | "failed" | "retrieved_ungraded")
    ) {
        return unknown();
    }
    let Some((identity, corpus)) =
        identity.and_then(|identity| corpora.get(identity).map(|corpus| (identity, corpus)))
    else {
        return unknown();
    };
    if !actual_hash_matches(row, identity, &corpus.prepared_source_sha256) {
        return unknown();
    }
    let Some(calls) = row["calls"].as_array() else {
        return unknown();
    };
    let mut sections = Proof::new();
    for call in calls {
        if call["status"] != "completed" {
            return unknown();
        }
        let Some(hits) = call["hits"].as_array() else {
            return unknown();
        };
        for hit in hits {
            let Some(key) = hit.as_str().filter(|key| !key.starts_with("expected:")) else {
                return unknown();
            };
            let Some(payload) = sources.get(key) else {
                return unknown();
            };
            let payload = payload.get("section").unwrap_or(payload);
            let Some(text) = payload["text"].as_str().filter(|text| !text.is_empty()) else {
                return unknown();
            };
            let offered: Proof = corpus
                .sections
                .iter()
                .filter(|(_, section)| {
                    payload["source_id"] == section.source_id
                        && payload["source_date"] == section.source_date
                        && text.contains(&section.text)
                })
                .map(|(id, _)| id.clone())
                .collect();
            if offered.is_empty() {
                return unknown();
            }
            sections.extend(offered);
        }
    }
    let activities: BTreeSet<_> = sections.iter().map(|(source, _)| source).collect();
    json!({"activities":activities.len(),"sections":sections.len(),"applicable":true})
}

/// Direct local evals have a fixed validated corpus instead of a benchmark plan.
/// Use the identical actual-text/corpus gate without changing their gold scores.
pub(super) fn enrich_eval(result: &mut Value, corpus: CorpusId) {
    let corpora = canonical_corpora();
    let identity = corpus.sha256();
    let Some(mut rows) = result
        .as_object_mut()
        .and_then(|result| result.remove("rows"))
    else {
        return;
    };
    if let (Some(rows), Some(sources)) = (rows.as_array_mut(), result["sources"].as_object()) {
        for row in rows {
            row["required_source_coverage"] = projection(row, sources, Some(&identity), &corpora);
            row["actual_retrieval"] = actual_retrieval(row, sources, Some(&identity), &corpora);
        }
    }
    result["rows"] = rows;
}
pub(super) fn enrich(snapshot: &mut Value) {
    let identities: BTreeMap<_, _> = snapshot["plan"]["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|group| {
            Some((
                group["id"].as_str()?.to_string(),
                group["identity"]["corpus_sha256"].as_str()?.to_string(),
            ))
        })
        .collect();
    let corpora = canonical_corpora();
    let Some(result) = snapshot.get_mut("result").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(mut rows) = result.remove("rows") else {
        return;
    };
    if let (Some(rows), Some(sources)) = (
        rows.as_array_mut(),
        result.get("sources").and_then(Value::as_object),
    ) {
        for row in rows {
            let identity = row["group_id"]
                .as_str()
                .and_then(|id| identities.get(id))
                .map(String::as_str);
            row["required_source_coverage"] = projection(row, sources, identity, &corpora);
            row["actual_retrieval"] = actual_retrieval(row, sources, identity, &corpora);
        }
    }
    result.insert("rows".into(), rows);
}

#[cfg(test)]
mod tests {
    use super::*;
    use meedoen_retrieval::corpus::CorpusId;
    fn refs() -> Vec<(&'static str, &'static str)> {
        ["ACT-FIETS-002", "ACT-TAAL-003"]
            .into_iter()
            .flat_map(|source| {
                ["S1", "S2", "S3", "S5"]
                    .into_iter()
                    .map(move |section| (source, section))
            })
            .collect()
    }
    fn reference(source: &str, section: &str) -> Value {
        json!({"source_id":source,"section_id":section,"found":true})
    }
    fn goal(alternatives: Vec<Vec<Value>>) -> Value {
        json!({"covered":true,"alternatives":alternatives})
    }
    fn snapshot(goals: Vec<Value>, offered: &[(&str, &str)]) -> Value {
        let corpus = CorpusId::DemoTwelve;
        let sections: Vec<_> = corpus
            .sources()
            .unwrap()
            .into_iter()
            .flat_map(|source| source.sections)
            .collect();
        let mut sources = serde_json::Map::new();
        let mut keys = Vec::new();
        for (source, section) in offered {
            let key = format!("actual:{source}:{section}");
            let canonical = sections
                .iter()
                .find(|row| row.source_id == *source && row.id == *section)
                .unwrap();
            sources.insert(key.clone(), serde_json::to_value(canonical).unwrap());
            keys.push(key);
        }
        json!({"plan":{"groups":[{"id":"retrieval:regression","identity":{"corpus_sha256":corpus.sha256()}}]},"result":{"rows":[{"group_id":"retrieval:regression","status":"failed","goals":goals,"calls":[{"status":"completed","hits":keys}],"metrics":{"covered_goals":10,"target_goals":10,"source_quality_applicable":true}}],"sources":sources}})
    }
    fn regression() -> Value {
        let required = refs();
        let mut goals: Vec<_> = required
            .iter()
            .map(|(source, section)| goal(vec![vec![reference(source, section)]]))
            .collect();
        // Free participation and available materials are separate facts in S5.
        goals.push(goal(vec![vec![reference("ACT-FIETS-002", "S5")]]));
        goals.push(goal(vec![vec![reference("ACT-TAAL-003", "S5")]]));
        snapshot(goals, &required)
    }
    #[test]
    fn actual_retrieval_counts_all_captured_activities_without_claiming_relevance() {
        let mut value = snapshot(
            vec![goal(vec![vec![reference("ACT-FIETS-002", "S2")]])],
            &[
                ("ACT-FIETS-002", "S2"),
                ("ACT-FIETS-002", "S3"),
                ("ACT-TUIN-001", "S1"),
                ("ACT-FIETS-002", "S2"),
            ],
        );
        enrich(&mut value);
        assert_eq!(
            value["result"]["rows"][0]["actual_retrieval"],
            json!({"activities":2,"sections":3,"applicable":true})
        );
        assert_eq!(
            value["result"]["rows"][0]["required_source_coverage"]["total"],
            1
        );
    }
    #[test]
    fn actual_retrieval_is_per_repeat_and_distinguishes_empty_from_unknown() {
        let mut value = regression();
        let mut second = value["result"]["rows"][0].clone();
        second["calls"][0]["hits"] = json!([]);
        value["result"]["rows"].as_array_mut().unwrap().push(second);
        enrich(&mut value);
        assert_eq!(
            value["result"]["rows"][0]["actual_retrieval"]["activities"],
            2
        );
        assert_eq!(
            value["result"]["rows"][1]["actual_retrieval"],
            json!({"activities":0,"sections":0,"applicable":true})
        );
        value["result"]["rows"][1]["status"] = json!("error");
        enrich(&mut value);
        assert!(value["result"]["rows"][1]["actual_retrieval"]["activities"].is_null());
        assert_ne!(
            value["result"]["rows"][1]["actual_retrieval"]["applicable"],
            true
        );
        assert!(
            value["result"]["rows"][1]["required_source_coverage"]["applicable"].is_null(),
            "execution errors leave source coverage unassessed"
        );
    }
    #[test]
    fn ten_facts_require_eight_unique_sections_and_two_documents() {
        let mut value = regression();
        enrich(&mut value);
        let coverage = &value["result"]["rows"][0]["required_source_coverage"];
        assert_eq!(coverage["found"], 8);
        assert_eq!(coverage["total"], 8);
        assert_eq!(coverage["unit"], "sections");
        assert_eq!(coverage["documents"], json!({"found":2,"total":2}));
        assert_eq!(coverage["found_refs"].as_array().unwrap().len(), 8);
        assert!(coverage["missing_refs"].as_array().unwrap().is_empty());
        assert_eq!(
            value["result"]["rows"][0]["metrics"]["covered_goals"], 10,
            "display projection must not relabel existing scorer results"
        );
    }
    #[test]
    fn repetitions_share_payload_storage_without_sharing_offered_evidence() {
        let mut value = regression();
        value["result"]["rows"][0]["repeat"] = json!(1);
        let mut second = value["result"]["rows"][0].clone();
        second["repeat"] = json!(2);
        second["calls"][0]["hits"] = json!(["actual:ACT-FIETS-002:S2"]);
        let mut third = second.clone();
        third["repeat"] = json!(3);
        third["calls"][0]["hits"] = json!([]);
        value["result"]["rows"]
            .as_array_mut()
            .unwrap()
            .extend([second, third]);
        enrich(&mut value);
        let rows = value["result"]["rows"].as_array().unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| row["required_source_coverage"]["found"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![8, 1, 0]
        );
        assert_eq!(
            rows[1]["required_source_coverage"]["missing_refs"]
                .as_array()
                .unwrap()
                .len(),
            7
        );
        assert_eq!(
            rows[2]["required_source_coverage"]["missing_refs"]
                .as_array()
                .unwrap()
                .len(),
            8
        );
    }
    #[test]
    fn metadata_and_found_flags_without_actual_text_never_count() {
        let mut value = regression();
        for source in value["result"]["sources"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            source.as_object_mut().unwrap().remove("text");
        }
        enrich(&mut value);
        let coverage = &value["result"]["rows"][0]["required_source_coverage"];
        assert_eq!(coverage["found"], 0);
        assert_eq!(coverage["total"], 8);
        assert_eq!(coverage["missing_refs"].as_array().unwrap().len(), 8);
    }
    #[test]
    fn expected_text_hydration_and_citations_are_not_offered_evidence() {
        let full = regression();
        let mut value = full.clone();
        value["result"]["rows"][0]["calls"][0]["hits"] = json!([]);
        value["result"]["rows"][0]["citations"] = json!(
            refs()
                .iter()
                .map(|(source, section)| reference(source, section))
                .collect::<Vec<_>>()
        );
        let expected: serde_json::Map<_, _> = full["result"]["sources"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, payload)| (format!("expected:{key}"), payload.clone()))
            .collect();
        value["result"]["sources"] = json!(expected);
        enrich(&mut value);
        assert_eq!(
            value["result"]["rows"][0]["required_source_coverage"]["found"],
            0
        );
        // Even an accidental reference to a display-only entry remains excluded.
        value["result"]["rows"][0]["calls"][0]["hits"] = json!(
            value["result"]["sources"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>()
        );
        enrich(&mut value);
        assert_eq!(
            value["result"]["rows"][0]["required_source_coverage"]["found"],
            0
        );
    }
    #[test]
    fn actual_whole_activity_text_can_offer_all_required_contained_sections() {
        let mut value = regression();
        let corpus = CorpusId::DemoTwelve;
        value["result"]["sources"] = json!({"actual-bike":{"kind":"activity","source_id":"ACT-FIETS-002","source_date":"2026-10-18","text":corpus.documents()[1]},"actual-language":{"kind":"activity","source_id":"ACT-TAAL-003","source_date":"2026-10-19","text":corpus.documents()[2]}});
        value["result"]["rows"][0]["calls"][0]["hits"] = json!(["actual-bike", "actual-language"]);
        enrich(&mut value);
        assert_eq!(
            value["result"]["rows"][0]["required_source_coverage"]["found"],
            8
        );
    }
    #[test]
    fn or_choices_select_one_complete_proof_plan_instead_of_unioning_alternatives() {
        let goals = vec![
            goal(vec![
                vec![
                    reference("ACT-FIETS-002", "S2"),
                    reference("ACT-FIETS-002", "S3"),
                ],
                vec![
                    reference("ACT-TAAL-003", "S2"),
                    reference("ACT-TAAL-003", "S3"),
                ],
            ]),
            goal(vec![vec![reference("ACT-FIETS-002", "S3")]]),
        ];
        let mut value = snapshot(
            goals.clone(),
            &[
                ("ACT-TAAL-003", "S2"),
                ("ACT-TAAL-003", "S3"),
                ("ACT-FIETS-002", "S3"),
            ],
        );
        enrich(&mut value);
        let coverage = &value["result"]["rows"][0]["required_source_coverage"];
        assert_eq!(coverage["found"], 3);
        assert_eq!(coverage["total"], 3);
        assert_eq!(coverage["has_alternatives"], true);
        let mut other = snapshot(goals, &[("ACT-FIETS-002", "S2"), ("ACT-FIETS-002", "S3")]);
        enrich(&mut other);
        assert_eq!(
            other["result"]["rows"][0]["required_source_coverage"]["found"],
            2
        );
        assert_eq!(
            other["result"]["rows"][0]["required_source_coverage"]["total"],
            2
        );
    }
    #[test]
    fn prepared_section_identity_is_not_the_raw_document_hash_and_wrong_corpora_stay_unknown() {
        use meedoen_retrieval::retrieval::PreparedCorpus;
        let prepared_hash = |corpus: CorpusId| {
            PreparedCorpus::new(
                corpus
                    .sources()
                    .unwrap()
                    .into_iter()
                    .flat_map(|source| source.sections)
                    .collect(),
                None,
                None,
            )
            .unwrap()
            .identity
            .source_sha256
        };
        let current = prepared_hash(CorpusId::DemoTwelve);
        assert_eq!(
            current,
            "be58098a9cf757adc486706277f6d35246135d82777d17c5b2e2e2264117a50a"
        );
        assert_ne!(current, CorpusId::DemoTwelve.sha256());
        let mut value = regression();
        value["result"]["rows"][0]["corpus_identity"] = json!({"source_sha256":current});
        enrich(&mut value);
        assert_eq!(
            value["result"]["rows"][0]["required_source_coverage"]["found"],
            8
        );
        assert_eq!(
            value["result"]["rows"][0]["corpus_identity"]["source_sha256"], current,
            "raw provenance must not be rewritten"
        );
        for wrong in [CorpusId::BaselineFive, CorpusId::ExpandedTen] {
            value["result"]["rows"][0]["corpus_identity"]["source_sha256"] =
                json!(prepared_hash(wrong));
            enrich(&mut value);
            assert!(value["result"]["rows"][0]["required_source_coverage"]["found"].is_null());
        }
    }
    #[test]
    fn unknown_or_wrong_corpus_binding_is_unassessed_and_no_targets_are_not_applicable() {
        let mut missing = regression();
        missing["plan"]["groups"][0]["identity"]["corpus_sha256"] = json!("unknown");
        enrich(&mut missing);
        assert!(missing["result"]["rows"][0]["required_source_coverage"]["found"].is_null());
        let mut mismatch = regression();
        mismatch["result"]["rows"][0]["corpus_identity"] =
            json!({"source_sha256":CorpusId::BaselineFive.sha256()});
        enrich(&mut mismatch);
        assert!(mismatch["result"]["rows"][0]["required_source_coverage"]["found"].is_null());
        let mut none = snapshot(vec![], &[]);
        enrich(&mut none);
        let coverage = &none["result"]["rows"][0]["required_source_coverage"];
        assert_eq!(coverage["applicable"], false);
        assert!(coverage["found"].is_null());
        assert!(coverage["total"].is_null());
    }
}
