use super::*;
use crate::Section;

fn fixture_sections() -> Vec<Section> {
    crate::source::parse_sources(crate::DOCUMENTS)
        .unwrap()
        .into_iter()
        .flat_map(|source| source.sections)
        .collect()
}

fn identity(dimensions: usize) -> EmbeddingIdentity {
    EmbeddingIdentity {
        provider: "local-test-vectors".into(),
        model: "explicit-two-dimensional-fixture".into(),
        sdk: "test".into(),
        dimensions,
        document_prefix: String::new(),
        query_prefix: String::new(),
        encoding: "title-heading-text".into(),
    }
}

#[test]
fn activity_records_normalize_only_explicit_facts_and_keep_source_evidence() {
    let mut sections = fixture_sections();
    for section in &mut sections {
        if section.source_id == "ACT-FIETS-002" {
            section.source_id = "RENAMED-ACTIVITY".into();
        }
    }
    let corpus = PreparedCorpus::new(sections, None, None).unwrap();
    assert_eq!(corpus.activities.len(), 5);
    let bicycle = corpus
        .activities
        .iter()
        .find(|activity| activity.id == "RENAMED-ACTIVITY")
        .unwrap();
    assert_eq!(bicycle.section_ids.len(), 6);
    let schedule = bicycle.schedule.as_ref().unwrap();
    assert_eq!(schedule.value.weekdays, [Weekday::Tuesday]);
    assert_eq!(schedule.value.time.start_minutes, 14 * 60);
    assert_eq!(schedule.value.time.end_minutes, 16 * 60);
    assert_eq!(
        bicycle.environment.as_ref().unwrap().value,
        Environment::Indoor
    );
    for evidence in schedule
        .evidence
        .iter()
        .chain(&bicycle.environment.as_ref().unwrap().evidence)
    {
        assert!(corpus.sections.iter().any(|section| {
            section.source_id == evidence.source_id
                && section.id == evidence.section_id
                && section.source_date == evidence.source_date
                && section.text.contains(&evidence.quote)
        }));
    }
    assert!(corpus.identity.vectors_sha256.is_none());
    corpus.validate().unwrap();
}

#[test]
fn unknown_or_conflicting_facts_stay_unknown() {
    let sections = vec![
        section("A", "S1", "Binnen is niet beschreven. Misschien dinsdag."),
        section("B", "S1", "We werken binnen."),
        section("B", "S2", "Je werkt buiten."),
    ];
    let corpus = PreparedCorpus::new(sections, None, None).unwrap();
    assert!(
        corpus
            .activities
            .iter()
            .all(|activity| activity.schedule.is_none())
    );
    assert!(
        corpus
            .activities
            .iter()
            .all(|activity| activity.environment.is_none())
    );
}

#[test]
fn conditional_environment_statements_do_not_become_hard_filter_facts() {
    for text in [
        "We werken binnen als het regent.",
        "We werken binnen soms.",
        "We werken binnen en buiten.",
        "We werken binnen tenzij het zonnig is.",
        "We werken binnen twee weken aan fietsen.",
        "We werken binnen de gemeente.",
        "We werken binnen bij regen.",
        "We werken buiten de gemeente.",
        "We werken buiten kantooruren.",
        "Je werkt buiten de openingstijden.",
    ] {
        let corpus = PreparedCorpus::new(vec![section("A", "S1", text)], None, None).unwrap();
        assert!(
            corpus.activities[0].environment.is_none(),
            "inferred unconditional environment from {text}"
        );
        let outcome = retrieve(
            &corpus,
            &RetrievalRequest {
                query: text.into(),
                filters: QueryFilters {
                    environment: Some(Environment::Indoor),
                    ..Default::default()
                },
            },
            &RetrievalConfig {
                method: SearchMethod::Bm25,
                apply_filters: true,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(outcome.filters.matched_activity_ids.is_empty());
        assert_eq!(outcome.filters.unknown_activities[0].source_id, "A");
        assert!(outcome.hits.is_empty());
    }
}

#[test]
fn corpus_rejects_duplicate_identity_invalid_vectors_and_changed_provenance() {
    let sections = vec![section("A", "S1", "Exact source text.")];
    assert!(
        PreparedCorpus::new(vec![sections[0].clone(), sections[0].clone()], None, None).is_err()
    );
    assert!(PreparedCorpus::new(sections.clone(), Some(vec![vec![1.0, 0.0]]), None).is_err());
    assert!(
        PreparedCorpus::new(sections.clone(), Some(vec![vec![1.0]]), Some(identity(2))).is_err()
    );
    assert!(
        PreparedCorpus::new(
            sections.clone(),
            Some(vec![vec![0.0, 0.0]]),
            Some(identity(2))
        )
        .is_err()
    );
    let mut corpus =
        PreparedCorpus::new(sections, Some(vec![vec![1.0, 0.0]]), Some(identity(2))).unwrap();
    assert!(corpus.identity.vectors_sha256.is_some());
    corpus.validate().unwrap();
    corpus.sections[0].text.push_str(" Changed after indexing.");
    assert!(corpus.validate().is_err());
}

fn section(source: &str, id: &str, text: &str) -> Section {
    Section {
        source_id: source.into(),
        source_date: "2026-10-20".into(),
        source_title: format!("Activity {source}"),
        id: id.into(),
        heading: "Details".into(),
        text: text.into(),
    }
}

fn request(query: &str) -> RetrievalRequest {
    RetrievalRequest {
        query: query.into(),
        filters: QueryFilters::default(),
    }
}

fn ranked_corpus() -> PreparedCorpus {
    PreparedCorpus::new(
        vec![
            section("A", "S1", "alpha alpha"),
            section("A", "S2", "workshop address"),
            section("B", "S1", "beta alpha"),
            section("C", "S1", "gamma"),
        ],
        Some(vec![
            vec![1.0, 0.0],
            vec![0.8, 0.2],
            vec![0.0, 1.0],
            vec![-1.0, 0.0],
        ]),
        Some(identity(2)),
    )
    .unwrap()
}

#[test]
fn keyword_mode_needs_no_vectors_and_returns_no_zero_score_padding() {
    let corpus = PreparedCorpus::new(fixture_sections(), None, None).unwrap();
    let config = RetrievalConfig {
        method: SearchMethod::Bm25,
        ..Default::default()
    };
    let result = retrieve(&corpus, &request("allergenen"), &config, None).unwrap();
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].section.source_id, "ACT-KOKEN-004");
    assert_eq!(result.hits[0].section.id, "S5");
    assert!(result.hits[0].scores.as_ref().unwrap().bm25_score.unwrap() > 0.0);
    assert_eq!(result.work.dense_vectors_scored, 0);
    assert_eq!(result.work.lexical_sections_scored, 30);
    let unmatched = retrieve(&corpus, &request("zzzzunknownword"), &config, None).unwrap();
    assert!(unmatched.hits.is_empty());
    assert!(unmatched.candidates.is_empty());
}

#[test]
fn exact_dense_ranking_keeps_raw_scores_and_does_not_silently_fallback() {
    let corpus = ranked_corpus();
    let result = retrieve(
        &corpus,
        &request("gamma"),
        &RetrievalConfig::default(),
        Some(&[1.0, 0.0]),
    )
    .unwrap();
    assert_eq!(result.hits[0].section.source_id, "A");
    assert_eq!(
        result.hits[0].scores.as_ref().unwrap().dense_similarity,
        Some(1.0)
    );
    assert_eq!(result.work.dense_vectors_scored, 4);
    assert_eq!(result.work.lexical_sections_scored, 0);
    assert!(
        retrieve(
            &corpus,
            &request("gamma"),
            &RetrievalConfig::default(),
            None
        )
        .is_err()
    );
    assert!(
        retrieve(
            &corpus,
            &request("gamma"),
            &RetrievalConfig::default(),
            Some(&[0.0, 0.0])
        )
        .is_err()
    );
    assert!(
        retrieve(
            &corpus,
            &request("gamma"),
            &RetrievalConfig::default(),
            Some(&[1.0])
        )
        .is_err()
    );
}

#[test]
fn rrf_and_weighted_fusion_have_distinct_documented_score_provenance() {
    let corpus = ranked_corpus();
    let mut config = RetrievalConfig {
        method: SearchMethod::HybridRrf,
        ..Default::default()
    };
    let rrf = retrieve(&corpus, &request("gamma"), &config, Some(&[1.0, 0.0])).unwrap();
    assert_eq!(rrf.hits[0].section.source_id, "C");
    let score = rrf.hits[0].scores.as_ref().unwrap();
    assert_eq!(score.dense_rank, Some(4));
    assert_eq!(score.keyword_rank, Some(1));
    assert!((score.rank_score - (1.0 / 64.0 + 1.0 / 61.0)).abs() < 1e-12);
    config.method = SearchMethod::HybridWeighted;
    let weighted = retrieve(&corpus, &request("gamma"), &config, Some(&[1.0, 0.0])).unwrap();
    assert_eq!(weighted.hits[0].section.source_id, "A");
    assert!((weighted.hits[0].scores.as_ref().unwrap().rank_score - 0.7).abs() < 1e-12);
    let c = weighted
        .candidates
        .iter()
        .find(|candidate| candidate.key.source_id == "C")
        .unwrap();
    assert!((c.scores.rank_score - 0.3).abs() < 1e-12);
    let no_words = retrieve(&corpus, &request("nooverlap"), &config, Some(&[1.0, 0.0])).unwrap();
    assert!(
        no_words
            .candidates
            .iter()
            .all(|candidate| candidate.scores.keyword_rank.is_none())
    );
}

#[test]
fn candidate_windows_and_document_section_identity_are_preserved() {
    let corpus = ranked_corpus();
    let config = RetrievalConfig {
        method: SearchMethod::HybridRrf,
        candidate_k: 1,
        top_k: 3,
        ..Default::default()
    };
    let result = retrieve(&corpus, &request("gamma"), &config, Some(&[1.0, 0.0])).unwrap();
    assert_eq!(result.work.union_candidates, 2);
    assert_eq!(result.hits.len(), 2);
    assert_eq!(
        result.candidates[0].key,
        SectionKey {
            source_id: "A".into(),
            section_id: "S1".into()
        }
    );
    assert_eq!(
        result.candidates[1].key,
        SectionKey {
            source_id: "C".into(),
            section_id: "S1".into()
        }
    );
    let scores = result.candidates[1].scores.clone();
    assert_eq!(scores.dense_rank, None);
    assert_eq!(scores.keyword_rank, Some(1));
}

#[test]
fn typed_filters_check_requirements_and_report_unknown_fields_separately() {
    let mut sections = fixture_sections();
    sections.push(section(
        "UNKNOWN",
        "S1",
        "Dinsdag en binnen zijn nog niet beschreven.",
    ));
    let corpus = PreparedCorpus::new(sections, None, None).unwrap();
    let mut request = request("dinsdag");
    request.filters = QueryFilters {
        weekdays: vec![Weekday::Tuesday],
        environment: Some(Environment::Indoor),
        time: Some(TimeWindow {
            start_minutes: 13 * 60,
            end_minutes: 17 * 60,
        }),
    };
    let mut config = RetrievalConfig {
        method: SearchMethod::Bm25,
        apply_filters: true,
        ..Default::default()
    };
    let result = retrieve(&corpus, &request, &config, None).unwrap();
    assert!(!result.hits.is_empty());
    assert!(
        result
            .hits
            .iter()
            .all(|hit| hit.section.source_id == "ACT-FIETS-002")
    );
    assert_eq!(result.filters.matched_activity_ids, ["ACT-FIETS-002"]);
    assert!(
        result
            .filters
            .excluded_activity_ids
            .contains(&"ACT-TUIN-001".into())
    );
    assert_eq!(result.filters.unknown_activities[0].source_id, "UNKNOWN");
    assert!(
        result.filters.unknown_activities[0]
            .fields
            .contains(&"schedule".into())
    );
    assert!(
        result.filters.unknown_activities[0]
            .fields
            .contains(&"environment".into())
    );
    config.apply_filters = false;
    let unfiltered = retrieve(&corpus, &request, &config, None).unwrap();
    assert!(!unfiltered.filters.applied);
    assert!(unfiltered.filters.ignored_reason.is_some());
    assert!(
        unfiltered
            .hits
            .iter()
            .any(|hit| hit.section.source_id == "ACT-TUIN-001")
    );
}

#[test]
fn time_filter_requires_the_whole_activity_to_fit() {
    let corpus = PreparedCorpus::new(fixture_sections(), None, None).unwrap();
    let config = RetrievalConfig {
        method: SearchMethod::Bm25,
        apply_filters: true,
        ..Default::default()
    };
    for (label, start_minutes, end_minutes, expected_sources) in [
        (
            "exact activity window",
            14 * 60,
            16 * 60,
            vec!["ACT-FIETS-002"],
        ),
        ("start is too late", 14 * 60 + 30, 16 * 60 + 30, vec![]),
        ("end is too early", 13 * 60 + 30, 15 * 60 + 30, vec![]),
    ] {
        let request = RetrievalRequest {
            query: "dinsdag".into(),
            filters: QueryFilters {
                weekdays: vec![Weekday::Tuesday],
                time: Some(TimeWindow {
                    start_minutes,
                    end_minutes,
                }),
                ..Default::default()
            },
        };
        let result = retrieve(&corpus, &request, &config, None).unwrap();
        assert_eq!(
            result.filters.matched_activity_ids, expected_sources,
            "{label}"
        );
        assert_eq!(
            result.hits.is_empty(),
            expected_sources.is_empty(),
            "{label}"
        );
        assert!(
            result
                .hits
                .iter()
                .all(|hit| expected_sources.contains(&hit.section.source_id.as_str())),
            "{label} returned evidence from an excluded activity"
        );
    }
}

#[test]
fn activity_expansion_preserves_seeds_and_whole_canonical_sections_under_same_budget() {
    let corpus = PreparedCorpus::new(fixture_sections(), None, None).unwrap();
    let mut config = RetrievalConfig {
        method: SearchMethod::Bm25,
        top_k: 1,
        selection: SelectionMode::ActivityExpansion,
        ..Default::default()
    };
    let result = retrieve(&corpus, &request("reparatiemateriaal"), &config, None).unwrap();
    assert_eq!(result.seeds.len(), 1);
    assert_eq!(result.hits.len(), 6);
    assert_eq!(result.hits[0].section.id, "S5");
    assert_eq!(result.hits[0].inclusion, Inclusion::Seed);
    for hit in &result.hits {
        assert_eq!(hit.section.source_id, "ACT-FIETS-002");
        assert!(
            corpus
                .sections
                .iter()
                .any(|section| serde_json::to_value(section).unwrap()
                    == serde_json::to_value(&hit.section).unwrap())
        );
    }
    config.context_token_limit = estimate_section_tokens(&result.hits[0].section);
    let bounded = retrieve(&corpus, &request("reparatiemateriaal"), &config, None).unwrap();
    assert_eq!(bounded.hits.len(), 1);
    assert_eq!(bounded.omitted.len(), 5);
    assert_eq!(bounded.estimated_context_tokens, config.context_token_limit);
    config.context_token_limit -= 1;
    assert!(retrieve(&corpus, &request("reparatiemateriaal"), &config, None).is_err());
}

#[test]
fn optional_mmr_can_spread_seeds_without_rewriting_ranking_scores() {
    let corpus = PreparedCorpus::new(
        vec![
            section("A", "S1", "same repeated words"),
            section("A", "S2", "same repeated words"),
            section("B", "S1", "distinct other content"),
        ],
        Some(vec![vec![1.0, 0.0], vec![0.999, 0.001], vec![0.99, 0.01]]),
        Some(identity(2)),
    )
    .unwrap();
    let mut config = RetrievalConfig {
        top_k: 2,
        mmr_lambda: 0.2,
        ..Default::default()
    };
    let plain = retrieve(&corpus, &request("anything"), &config, Some(&[1.0, 0.0])).unwrap();
    assert_eq!(plain.hits[1].section.source_id, "A");
    config.mmr = true;
    let diverse = retrieve(&corpus, &request("anything"), &config, Some(&[1.0, 0.0])).unwrap();
    assert_eq!(diverse.hits[1].section.source_id, "B");
    assert_eq!(plain.candidates, diverse.candidates);
}

#[test]
fn activity_balanced_reserves_six_distinct_activity_seeds_without_changing_candidates() {
    let sections: Vec<_> = ["A", "A", "B", "C", "D", "E", "F", "G"]
        .iter()
        .enumerate()
        .map(|(index, activity)| section(activity, &format!("S{}", index + 1), "source evidence"))
        .collect();
    let vectors = (0..sections.len())
        .map(|index| vec![1.0, 0.1 * index as f32])
        .collect();
    let corpus = PreparedCorpus::new(sections, Some(vectors), Some(identity(2))).unwrap();
    let baseline = RetrievalConfig {
        selection: SelectionMode::ActivityExpansion,
        ..Default::default()
    };
    let original = retrieve(
        &corpus,
        &request("source evidence"),
        &baseline,
        Some(&[1.0, 0.0]),
    )
    .unwrap();
    let mut json = serde_json::to_value(&baseline).unwrap();
    json["selection"] = serde_json::json!("activity_balanced");
    json["top_k"] = serde_json::json!(6);
    let candidate: Result<RetrievalConfig, _> = serde_json::from_value(json);
    assert!(
        candidate.is_ok(),
        "The opt-in balanced policy must be selectable"
    );
    let candidate = candidate.unwrap();
    let balanced = retrieve(
        &corpus,
        &request("source evidence"),
        &candidate,
        Some(&[1.0, 0.0]),
    )
    .unwrap();
    assert_eq!(balanced.candidates, original.candidates);
    assert_eq!(balanced.config.top_k, 6);
    assert_eq!(
        balanced
            .seeds
            .iter()
            .map(|key| key.source_id.as_str())
            .collect::<Vec<_>>(),
        ["A", "B", "C", "D", "E", "F"]
    );
    assert!(!balanced.hits.iter().any(|hit| hit.section.source_id == "G"));
}

#[test]
fn activity_balanced_packs_sections_in_round_robin_under_the_same_budget() {
    let sections: Vec<_> = ["A", "B"]
        .iter()
        .flat_map(|activity| {
            (1..=3).map(move |index| {
                section(activity, &format!("S{index}"), "same canonical evidence")
            })
        })
        .collect();
    let vectors = (0..sections.len())
        .map(|index| vec![1.0, 0.1 * index as f32])
        .collect();
    let token_limit = sections
        .iter()
        .filter(|section| section.id != "S3")
        .map(estimate_section_tokens)
        .sum();
    let corpus = PreparedCorpus::new(sections, Some(vectors), Some(identity(2))).unwrap();
    let mut json = serde_json::to_value(RetrievalConfig {
        context_token_limit: token_limit,
        ..Default::default()
    })
    .unwrap();
    json["selection"] = serde_json::json!("activity_balanced");
    let config: Result<RetrievalConfig, _> = serde_json::from_value(json);
    assert!(
        config.is_ok(),
        "The opt-in balanced policy must be selectable"
    );
    let mut config = config.unwrap();
    let result = retrieve(&corpus, &request("evidence"), &config, Some(&[1.0, 0.0])).unwrap();
    assert_eq!(
        result
            .hits
            .iter()
            .map(|hit| (hit.section.source_id.as_str(), hit.section.id.as_str()))
            .collect::<Vec<_>>(),
        [("A", "S1"), ("B", "S1"), ("A", "S2"), ("B", "S2")]
    );
    assert_eq!(result.estimated_context_tokens, token_limit);
    assert_eq!(result.omitted.len(), 2);
    assert!(
        result
            .omitted
            .iter()
            .all(|omission| omission.key.section_id == "S3")
    );
    config.context_token_limit = result.hits[..2]
        .iter()
        .map(|hit| estimate_section_tokens(&hit.section))
        .sum::<usize>()
        - 1;
    assert!(
        retrieve(&corpus, &request("evidence"), &config, Some(&[1.0, 0.0]))
            .unwrap_err()
            .contains("seeds were not silently truncated")
    );
}

#[test]
fn activity_balanced_preserves_whole_seeds_and_expands_unranked_canonical_sections() {
    let corpus = PreparedCorpus::new(
        vec![
            section("A", "S1", "unique seed"),
            section("A", "S2", "other unranked text"),
        ],
        None,
        None,
    )
    .unwrap();
    let mut json = serde_json::to_value(RetrievalConfig {
        method: SearchMethod::Bm25,
        candidate_k: 1,
        top_k: 1,
        ..Default::default()
    })
    .unwrap();
    json["selection"] = serde_json::json!("activity_balanced");
    let config: Result<RetrievalConfig, _> = serde_json::from_value(json);
    assert!(
        config.is_ok(),
        "The opt-in balanced policy must be selectable"
    );
    let mut config = config.unwrap();
    let result = retrieve(&corpus, &request("unique seed"), &config, None).unwrap();
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(result.hits.len(), 2);
    assert_eq!(result.hits[1].section.id, "S2");
    assert_eq!(result.hits[1].scores, None);
    config.context_token_limit = estimate_section_tokens(&result.hits[0].section) - 1;
    assert!(
        retrieve(&corpus, &request("unique seed"), &config, None)
            .unwrap_err()
            .contains("seeds were not silently truncated")
    );
}

#[test]
fn activity_balanced_rejects_mmr_instead_of_ignoring_it() {
    let mut json = serde_json::to_value(RetrievalConfig {
        mmr: true,
        ..Default::default()
    })
    .unwrap();
    json["selection"] = serde_json::json!("activity_balanced");
    let config: Result<RetrievalConfig, _> = serde_json::from_value(json);
    assert!(
        config.is_ok(),
        "The opt-in balanced policy must be selectable"
    );
    assert!(
        validate_config(&config.unwrap(), &Default::default())
            .unwrap_err()
            .contains("MMR")
    );
    assert_eq!(
        RetrievalConfig::default().selection,
        SelectionMode::Sections
    );
}

#[test]
fn validation_rejects_invalid_queries_budgets_and_nonfinite_weights() {
    let corpus = ranked_corpus();
    let mut config = RetrievalConfig::default();
    assert!(retrieve(&corpus, &request("  "), &config, Some(&[1.0, 0.0])).is_err());
    config.top_k = 0;
    assert!(retrieve(&corpus, &request("query"), &config, Some(&[1.0, 0.0])).is_err());
    config.top_k = 3;
    config.candidate_k = 0;
    assert!(retrieve(&corpus, &request("query"), &config, Some(&[1.0, 0.0])).is_err());
    config.candidate_k = 30;
    config.vector_weight = f64::NAN;
    assert!(validate_config(&config, &QueryFilters::default()).is_err());
    assert!(retrieve(&corpus, &request("query"), &config, Some(&[1.0, 0.0])).is_err());
    config.vector_weight = 0.7;
    let request = RetrievalRequest {
        query: "query".into(),
        filters: QueryFilters {
            time: Some(TimeWindow {
                start_minutes: 1440,
                end_minutes: 1,
            }),
            ..Default::default()
        },
    };
    assert!(retrieve(&corpus, &request, &config, Some(&[1.0, 0.0])).is_err());
}

#[test]
fn purpose_prefixes_bind_the_actual_document_embedding_inputs() {
    let parsed = serde_json::from_value::<EmbeddingIdentity>(serde_json::json!({
        "provider":"local-test-vectors","model":"explicit-e5-fixture","sdk":"test",
        "dimensions":2,"encoding":"asymmetric retrieval","document_prefix":"passage: ","query_prefix":"query: "
    }));
    assert!(
        parsed.is_ok(),
        "Embedding identity must retain document and query prefixes"
    );
    let sections = fixture_sections();
    let vectors = vec![vec![1.0, 0.5]; sections.len()];
    let corpus =
        PreparedCorpus::new(sections.clone(), Some(vectors), Some(parsed.unwrap())).unwrap();
    let actual_inputs: Vec<String> = sections
        .iter()
        .map(|section| format!("passage: {}", embedding_input(section)))
        .collect();
    assert_eq!(
        corpus.identity.embedding_inputs_sha256,
        crate::manifest::hash(&serde_json::to_vec(&actual_inputs).unwrap())
    );
    let raw_inputs: Vec<_> = sections.iter().map(embedding_input).collect();
    assert_ne!(
        corpus.identity.embedding_inputs_sha256,
        crate::manifest::hash(&serde_json::to_vec(&raw_inputs).unwrap())
    );
}
