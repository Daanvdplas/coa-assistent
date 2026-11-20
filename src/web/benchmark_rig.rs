//! Fixed, conservative answer checks for the twelve-source IND26-01 regression.
//! References are assessment-only and are never supplied to the Runner.
use meedoen_retrieval::{
    DemoSearchMethod, codex::AnswerLanguage, corpus::CorpusId, responses::ResponsesRunner,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(super) const DATASET: &str = "regression-12-20261118";
const CASE: &str = "IND26-01";
#[cfg(test)]
const QUESTION: &str = "Welke activiteiten uit deze bronnen zijn binnen, beginnen om 14.00 uur, zijn gratis en hebben het materiaal voor de activiteit al aanwezig? Zet alle passende opties naast elkaar met de dag, eindtijd en wat je daar doet.";

fn question_set(dataset: &str) -> Result<Value, String> {
    use meedoen_retrieval::retrieval_lab::dataset as data;
    data::load(dataset)?;
    let text = match dataset {
        DATASET => data::REGRESSION_QUESTIONS,
        "demo-12-20261118" => data::DEMO_QUESTIONS,
        _ => return Err("Unknown current-assistant dataset".into()),
    };
    serde_json::from_str(text).map_err(|_| "Invalid current-assistant questions".into())
}
fn labels(dataset: &str) -> Result<Value, String> {
    use meedoen_retrieval::retrieval_lab::dataset as data;
    let (text, freeze) = match dataset {
        DATASET => (
            data::REGRESSION_EXPECTATIONS,
            include_str!("../../evals/shared/datasets/regression-12-20261118/FROZEN.json"),
        ),
        "demo-12-20261118" => (
            data::DEMO_EXPECTATIONS,
            include_str!("../../evals/shared/datasets/demo-12-20261118/FROZEN.json"),
        ),
        _ => return Err("Unknown current-assistant criteria".into()),
    };
    let frozen: Value =
        serde_json::from_str(freeze).map_err(|_| "Invalid protected reference freeze")?;
    let path = format!("evals/shared/datasets/{dataset}/expectations.json");
    if frozen["review"]["approved"] != true
        || !frozen["integrity"]["artifacts"]
            .as_array()
            .is_some_and(|artifacts| {
                artifacts.iter().any(|artifact| {
                    artifact["path"] == path
                        && artifact["sha256_bytes"]
                            == meedoen_retrieval::manifest::hash(text.as_bytes())
                })
            })
    {
        return Err("Protected reference differs from its approved freeze".into());
    }
    serde_json::from_str(text).map_err(|_| "Invalid current-assistant criteria".into())
}
fn normalized(text: &str) -> String {
    text.to_lowercase()
        .replace(['é', 'è', 'ë', 'ê'], "e")
        .replace(['ï', 'í'], "i")
        .replace('ó', "o")
}
fn words(text: &str) -> Vec<String> {
    normalized(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}
fn time_value(text: &str) -> Option<u32> {
    let trimmed = text.trim_matches(|c: char| !c.is_ascii_digit() && c != '.' && c != ':');
    let parts: Vec<_> = trimmed.split(['.', ':']).collect();
    let hour = parts.first()?.parse::<u32>().ok()?;
    let minute = if parts.len() == 2 {
        parts[1].parse::<u32>().ok()?
    } else if parts.len() == 1 {
        0
    } else {
        return None;
    };
    (hour < 24 && minute < 60).then_some(hour * 100 + minute)
}
fn times(text: &str) -> BTreeSet<u32> {
    let lower = normalized(text);
    let mut found = BTreeSet::new();
    for raw in lower.split_whitespace() {
        let range: Vec<_> = raw.split(['–', '—', '-']).collect();
        if range.len() == 2 {
            for value in range {
                if let Some(value) = time_value(value) {
                    found.insert(value);
                }
            }
        }
    }
    let tokens: Vec<_> = lower
        .split(|c: char| !c.is_alphanumeric() && c != '.' && c != ':')
        .filter(|part| !part.is_empty())
        .collect();
    for (index, token) in tokens.iter().enumerate() {
        let explicit = token.contains(':') || token.contains('.') || token.ends_with("uur");
        let context = index > 0 && ["om", "van", "tot"].contains(&tokens[index - 1])
            || tokens.get(index + 1) == Some(&"uur");
        if (explicit || context)
            && let Some(value) = time_value(token)
        {
            found.insert(value);
        }
    }
    found
}
fn day_matches(text: &str, expected: &str) -> bool {
    let tokens = words(text);
    let days = [
        "maandag",
        "dinsdag",
        "woensdag",
        "donderdag",
        "vrijdag",
        "zaterdag",
        "zondag",
    ];
    tokens.iter().any(|token| token == expected)
        && !days
            .iter()
            .any(|day| *day != expected && tokens.iter().any(|token| token == day))
}
fn contradictory(text: &str) -> bool {
    let text = normalized(text);
    let tokens = words(&text);
    let outside = (tokens.iter().any(|t| t == "buiten") && !text.contains("niet buiten"))
        || text.contains("niet binnen");
    let material = [
        "eigen materiaal is verplicht",
        "eigen materiaal verplicht",
        "materiaal ontbreekt",
        "geen materiaal aanwezig",
        "materiaal is niet aanwezig",
        "materiaal zelf meenemen",
        "zelf materiaal meenemen",
        "zelf materialen kopen",
    ]
    .iter()
    .any(|phrase| text.contains(phrase));
    let price = text.contains("niet gratis")
        || tokens.windows(2).any(|parts| {
            parts[1] == "euro"
                && (parts[0].parse::<f64>().is_ok_and(|amount| amount > 0.0)
                    || ["een", "twee", "drie", "vier", "vijf", "tien", "twintig"]
                        .contains(&parts[0].as_str()))
        });
    let no_confirmed_places = [
        "geen vrije plekken bevestigd",
        "geen vrije plaatsen bevestigd",
    ]
    .iter()
    .any(|phrase| text.contains(phrase));
    let places = !no_confirmed_places
        && text.contains("er zijn")
        && [
            "vrije plekken",
            "vrije plaatsen",
            "plek beschikbaar",
            "plaats beschikbaar",
            "plekken beschikbaar",
        ]
        .iter()
        .any(|phrase| text.contains(phrase));
    outside || material || price || places
}
fn strict_answer(text: &str, sources: &[meedoen_retrieval::source::Source]) -> Vec<Value> {
    let lower = normalized(text);
    let mut mentions = Vec::new();
    for source in sources {
        let title = normalized(&source.title);
        for (position, _) in lower.match_indices(&title) {
            mentions.push((position, title.len(), source.id.as_str()));
        }
    }
    mentions.sort_by_key(|mention| mention.0);
    let mut blocks: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut extras = false;
    let intro = mentions
        .first()
        .map_or(lower.as_str(), |mention| &lower[..mention.0]);
    let intro_consistent = !contradictory(intro);
    for (index, (position, length, id)) in mentions.iter().enumerate() {
        let end = mentions.get(index + 1).map_or(lower.len(), |next| next.0);
        let block = &lower[position + length..end];
        if ["ACT-FIETS-002", "ACT-TAAL-003"].contains(id) {
            blocks.entry(id).or_default().push(block);
        } else if !["valt af", "past niet", "niet passend", "voldoet niet"]
            .iter()
            .any(|phrase| block.contains(phrase))
        {
            extras = true;
        }
    }
    for line in lower.lines() {
        let line = line.trim();
        let listed = line.starts_with("- ")
            || line.starts_with("* ")
            || line.as_bytes().first().is_some_and(u8::is_ascii_digit) && line.contains(". ");
        if listed
            && !line.contains("fietsen opknappen")
            && !line.contains("taalcafe")
            && (!times(line).is_empty() || line.contains(':'))
        {
            extras = true;
        }
    }
    for sentence in lower.split(['.', '!', '?', '\n']) {
        if [
            " is een passende optie",
            " is een geschikte optie",
            " is ook passend",
            " past ook",
            " is daarnaast geschikt",
        ]
        .iter()
        .any(|claim| sentence.contains(claim))
            && !sentence.contains("fietsen opknappen")
            && !sentence.contains("taalcafe")
        {
            extras = true;
        }
    }
    let mut checks = Vec::new();
    let mut check = |id: &str, pass: bool, reason: &str| {
        checks.push(json!({"id":id,"pass":pass,"score":if pass{1}else{0},"reason":reason}))
    };
    check(
        "all_and_only_matching_options",
        blocks.contains_key("ACT-FIETS-002") && blocks.contains_key("ACT-TAAL-003") && !extras,
        "Alleen Fietsen opknappen en Taalcafé moeten volledig als passende opties zijn genoemd.",
    );
    check(
        "intro_conditions",
        intro_consistent,
        "Ook algemene uitspraken vóór de opties mogen de bronvoorwaarden niet tegenspreken.",
    );
    for (id, day, end, kind) in [
        ("ACT-FIETS-002", "dinsdag", 1600, "fiets"),
        ("ACT-TAAL-003", "woensdag", 1530, "taal"),
    ] {
        let option = blocks.get(id).cloned().unwrap_or_default();
        let detailed: Vec<_> = option
            .iter()
            .copied()
            .filter(|block| {
                !times(block).is_empty()
                    || words(block).iter().any(|word| {
                        [
                            "maandag",
                            "dinsdag",
                            "woensdag",
                            "donderdag",
                            "vrijdag",
                            "zaterdag",
                            "zondag",
                        ]
                        .contains(&word.as_str())
                    })
            })
            .collect();
        let date_ok = detailed.iter().any(|block| day_matches(block, day))
            && detailed.iter().all(|block| {
                words(block)
                    .iter()
                    .filter(|word| {
                        [
                            "maandag",
                            "dinsdag",
                            "woensdag",
                            "donderdag",
                            "vrijdag",
                            "zaterdag",
                            "zondag",
                        ]
                        .contains(&word.as_str())
                    })
                    .all(|word| word == day)
            });
        let time_ok = detailed.iter().any(|block| times(block).contains(&end))
            && detailed
                .iter()
                .all(|block| times(block).iter().all(|value| [1400, end].contains(value)));
        let action_ok = detailed.iter().any(|block| {
            if kind == "fiets" {
                (block.contains("repar") && block.contains("fiets"))
                    || (block.contains("band") && block.contains("plak"))
                    || (block.contains("fiets")
                        && (block.contains("schoonmak")
                            || block.contains("opknap")
                            || block.contains("knap") && block.contains(" op")))
            } else {
                block.contains("taalspel")
                    || block.contains("nederlands")
                        && ["oefen", "gesprek", "prat"]
                            .iter()
                            .any(|verb| block.contains(verb))
            }
        });
        check(
            &format!("{kind}_day"),
            date_ok,
            &format!("De juiste dag voor deze optie is {day}."),
        );
        check(
            &format!("{kind}_time"),
            time_ok,
            &format!(
                "De start is 14.00; de eindtijd voor deze optie is {}.{:02}.",
                end / 100,
                end % 100
            ),
        );
        check(
            &format!("{kind}_activity"),
            action_ok,
            "De beschreven handeling moet overeenkomen met de activiteit, niet alleen de activiteitnaam.",
        );
        check(
            &format!("{kind}_conditions"),
            !option.is_empty() && option.iter().all(|block| !contradictory(block)),
            "Het antwoord mag binnen/gratis/aanwezig materiaal niet tegenspreken of actuele plekken bevestigen.",
        );
    }
    checks
}
fn assessment(capture: &Value, dataset: &str, case_id: &str) -> Value {
    let corpus = CorpusId::DemoTwelve;
    let sources = corpus.sources().unwrap_or_default();
    let sections: Vec<_> = sources
        .iter()
        .flat_map(|source| source.sections.iter())
        .collect();
    let input = question_set(dataset).ok();
    let question = input
        .as_ref()
        .and_then(|set| set["cases"].as_array())
        .and_then(|cases| cases.iter().find(|case| case["id"] == case_id))
        .and_then(|case| case["question"].as_str())
        .unwrap_or("");
    let criteria = labels(dataset)
        .ok()
        .and_then(|labels| {
            labels["cases"]
                .as_array()
                .and_then(|cases| cases.iter().find(|case| case["case_id"] == case_id))
                .cloned()
        })
        .unwrap_or(Value::Null);
    let mut found = BTreeSet::new();
    let mut trace_valid = true;
    let mut public_sources = BTreeMap::new();
    let mut calls = Vec::new();
    let traces = capture["tool_calls"].as_array();
    if traces.is_none_or(|calls| calls.is_empty() || calls.len() > 4) {
        trace_valid = false;
    }
    for (index, call) in traces.into_iter().flatten().enumerate() {
        let result = &call["result"];
        if call["status"] != "completed"
            || result["manifest"] != capture["manifest"]
            || result["as_of"] != corpus.as_of()
        {
            trace_valid = false;
        }
        let mut hits = Vec::new();
        for hit in result["hits"].as_array().into_iter().flatten() {
            let value = &hit["section"];
            let canonical = sections.iter().find(|section| {
                section.source_id == value["source_id"] && section.id == value["id"]
            });
            if let Some(section) = canonical
                .filter(|section| serde_json::to_value(section).ok().as_ref() == Some(value))
            {
                let key = format!(
                    "{}:{}:{}",
                    section.source_id,
                    section.id,
                    meedoen_retrieval::manifest::hash(section.text.as_bytes())
                );
                found.insert((section.source_id.clone(), section.id.clone()));
                public_sources.insert(key.clone(), value.clone());
                hits.push(key);
            } else if hit["kind"] == "activity" {
                let source = sources.iter().find(|source| {
                    source.id == hit["source_id"] && source.date == hit["source_date"]
                });
                let text = hit["text"].as_str().unwrap_or("");
                let mut count = 0;
                if let Some(source) = source {
                    for section in &source.sections {
                        if text.contains(&section.text) {
                            let key = format!(
                                "{}:{}:{}",
                                section.source_id,
                                section.id,
                                meedoen_retrieval::manifest::hash(section.text.as_bytes())
                            );
                            found.insert((section.source_id.clone(), section.id.clone()));
                            public_sources
                                .insert(key.clone(), serde_json::to_value(section).unwrap());
                            hits.push(key);
                            count += 1;
                        }
                    }
                }
                if count == 0 {
                    trace_valid = false;
                }
            } else {
                trace_valid = false;
            }
        }
        calls.push(
            json!({"index":index+1,"query":call["query"],"hits":hits,"status":call["status"]}),
        );
    }
    let mut goals = Vec::new();
    if dataset == DATASET {
        for id in ["ACT-FIETS-002", "ACT-TAAL-003"] {
            for sid in ["S1", "S2", "S3", "S5"] {
                let present = found.contains(&(id.into(), sid.into()));
                let section = sections
                    .iter()
                    .find(|section| section.source_id == id && section.id == sid)
                    .unwrap();
                goals.push(json!({"id":format!("{id}:{sid}"),"description":format!("{} · {}",section.source_title,section.heading),"covered":present,"alternatives":[[{"source_id":id,"section_id":sid,"found":present}]]}));
            }
        }
    } else {
        for fact in criteria["facts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|fact| {
                fact["evidence_alternatives"]
                    .as_array()
                    .is_some_and(|alternatives| !alternatives.is_empty())
            })
        {
            let alternatives:Vec<Value>=fact["evidence_alternatives"].as_array().unwrap().iter().map(|alternative|json!(alternative.as_array().into_iter().flatten().map(|reference|json!({"source_id":reference["source_id"],"section_id":reference["section_id"],"found":found.contains(&(reference["source_id"].as_str().unwrap_or("").into(),reference["section_id"].as_str().unwrap_or("").into()))})).collect::<Vec<_>>())).collect();
            let covered = alternatives.iter().any(|alternative| {
                alternative
                    .as_array()
                    .is_some_and(|refs| refs.iter().all(|reference| reference["found"] == true))
            });
            goals.push(json!({"id":fact["id"],"description":fact["description"],"covered":covered,"alternatives":alternatives}));
        }
    }
    let target = goals.len();
    let covered = goals.iter().filter(|goal| goal["covered"] == true).count();
    let complete = (target > 0).then_some(covered == target);
    let mut checks = vec![
        json!({"id":"protected_reference_bound","pass":criteria["case_id"]==case_id,"reason":"De beoordeling gebruikt de vastgelegde, onafhankelijk brongecontroleerde criteriaversie."}),
        json!({"id":"current_rig_capture","pass":capture["status"]=="completed"&&capture["provider"]=="openai"&&capture["transport"]=="responses_api"&&capture["client_version"]=="rig-0.46.0"&&capture["question"]==question&&!question.is_empty(),"reason":"Uitvoer uit de huidige Responses/Rig-route met exact de geselecteerde vraag."}),
        json!({"id":"canonical_corpus_trace","pass":trace_valid&&capture["manifest"]["source_sha256"]==corpus.sha256()&&capture["as_of"]==corpus.as_of(),"reason":"Werkelijk aangeboden bronpayloads, tekst, datum en corpusbinding komen overeen."}),
    ];
    if let Some(complete) = complete {
        checks.push(json!({"id":"complete_source_evidence","pass":complete,"reason":format!("{covered}/{target} verwachte bewijsdoelen werkelijk aangeboden.")}));
    }
    let citations = capture["answer"]["citations"].as_array();
    let citations_valid = citations.is_some_and(|citations| {
        !citations.is_empty()
            || capture["answer"]["unknowns"]
                .as_array()
                .is_some_and(|unknowns| !unknowns.is_empty())
    }) && citations.into_iter().flatten().all(|citation| {
        sections.iter().any(|section| {
            section.source_id == citation["source_id"]
                && section.id == citation["section_id"]
                && section.source_date == citation["source_date"]
                && found.contains(&(section.source_id.clone(), section.id.clone()))
                && citation["quote"]
                    .as_str()
                    .is_some_and(|quote| !quote.trim().is_empty() && section.text.contains(quote))
        })
    });
    checks.push(json!({"id":"citations_match_actual_evidence","pass":citations_valid,"reason":"Citaten verwijzen naar werkelijk aangeboden tekst met juiste bron en datum."}));
    if dataset == DATASET {
        checks.extend(strict_answer(
            capture["answer"]["text"].as_str().unwrap_or(""),
            &sources,
        ));
    }
    for check in &mut checks {
        check["score"] = json!(if check["pass"] == true { 1 } else { 0 });
    }
    let passed = checks.iter().all(|check| check["pass"] == true);
    // Expected text is a downstream display aid; it never changes found flags.
    for goal in &goals {
        for reference in goal["alternatives"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|option| option.as_array().into_iter().flatten())
        {
            if let Some(section) = sections.iter().find(|section| {
                section.source_id == reference["source_id"] && section.id == reference["section_id"]
            }) {
                public_sources
                    .entry(format!("expected:{}:{}", section.source_id, section.id))
                    .or_insert_with(|| serde_json::to_value(section).unwrap());
            }
        }
    }
    json!({"passed":passed,"source_complete":complete,"latency_eligible":dataset==DATASET&&passed,"answer_quality":if dataset==DATASET{"deterministic_case_specific_not_human"}else{"not_assessed"},"assertions":checks,"goals":goals,"calls":calls,"sources":public_sources,"metrics":{"target_goals":target,"covered_goals":covered,"source_quality_applicable":target>0,"search_calls":traces.map_or(0,Vec::len),"provider_attempts":capture["provider_requests"]}})
}
pub(super) fn assess(capture: &Value) -> Value {
    assessment(capture, DATASET, CASE)
}
fn save_new(path: &Path, value: &Value) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "Cannot create a new Rig capture")?;
    file.write_all(&serde_json::to_vec(value).map_err(|_| "Cannot encode Rig capture")?)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot preserve Rig capture".into())
}
fn checkpoint(path: &Path, value: &Value) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| "Cannot create Rig checkpoint")?;
    file.write_all(&serde_json::to_vec(value).map_err(|_| "Cannot encode Rig checkpoint")?)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot preserve Rig checkpoint")?;
    std::fs::rename(temp, path).map_err(|_| "Cannot replace Rig checkpoint")?;
    std::fs::File::open(path.parent().ok_or("Missing Rig output directory")?)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Cannot sync Rig checkpoint".into())
}
pub(super) async fn execute_group(
    group: &Value,
    selection: &Value,
    runner: Option<ResponsesRunner>,
    output: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, String> {
    let runner = runner.ok_or("The current Responses/Rig assistant is not configured")?;
    let dataset = group["dataset"].as_str().ok_or("Missing Rig dataset")?;
    let questions = question_set(dataset)?; // Input only; protected labels load after the capture is saved.
    let authorization = &selection["authorization"];
    let attempts = authorization["max_attempts"]
        .as_u64()
        .filter(|limit| *limit > 0)
        .ok_or("An explicit positive provider-attempt limit is required")?;
    let seconds = authorization["max_seconds"]
        .as_u64()
        .filter(|limit| *limit > 0)
        .ok_or("An explicit positive execution window is required")?;
    if authorization["confirmed"] != true
        || group["execution_count"]
            .as_u64()
            .ok_or("Missing Rig plan count")?
            .saturating_mul(5)
            > attempts
        || runner.configuration()["max_provider_requests"] != 5
    {
        return Err("The Rig plan exceeds its approved provider-attempt policy".into());
    }
    std::fs::create_dir_all(output).map_err(|_| "Cannot create private Rig output")?;
    let path = output.join("rig-progress.json");
    let mut progress =
        json!({"rows":[],"sources":{},"completed":0,"status":"running","error":null});
    checkpoint(&path, &progress)?;
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let repeats = selection["repeats"].as_u64().unwrap_or(1);
    let selected = selection["case_ids"].as_array();
    for question in questions["cases"]
        .as_array()
        .ok_or("Missing Rig questions")?
    {
        let case_id = question["id"].as_str().ok_or("Missing Rig case")?;
        if selected.is_some_and(|cases| !cases.is_empty() && !cases.iter().any(|id| id == case_id))
        {
            continue;
        }
        let text = question["question"]
            .as_str()
            .ok_or("Missing visitor question")?;
        for configuration in group["configurations"]
            .as_array()
            .ok_or("Missing Rig configurations")?
        {
            for repeat in 1..=repeats {
                if *cancel.borrow() {
                    progress["status"] = json!("cancelled");
                    checkpoint(&path, &progress)?;
                    return Ok(progress);
                }
                if Instant::now() >= deadline {
                    progress["status"] = json!("failed");
                    progress["error"] = json!(
                        "Het toegestane uitvoeringsvenster is verstreken; er wordt geen nieuwe modelpoging gestart."
                    );
                    checkpoint(&path, &progress)?;
                    return Ok(progress);
                }
                let method = match configuration["configuration"]["method"].as_str() {
                    Some("dense") => DemoSearchMethod::Dense,
                    Some("bm25") => DemoSearchMethod::Bm25,
                    _ => return Err("Unknown current-assistant retrieval method".into()),
                };
                let configuration_id = configuration["id"]
                    .as_str()
                    .filter(|id| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
                    .ok_or("Invalid Rig configuration identity")?;
                let result = tokio::select! {
                    biased;
                    _=cancel.changed()=>{progress["status"]=json!("cancelled");checkpoint(&path,&progress)?;return Ok(progress);},
                    _=tokio::time::sleep_until(deadline.into())=>Err("runtime: Het toegestane uitvoeringsvenster is verstreken.".into()),
                    result=runner.run(text,3,CorpusId::DemoTwelve,AnswerLanguage::Nl,method)=>result,
                };
                let captured = result.as_ref().cloned().unwrap_or_else(
                    |_| json!({"status":"failed","question":text,"runtime":"responses-rig"}),
                );
                let filename = output.join(format!("{case_id}-{configuration_id}-{repeat}.json"));
                save_new(&filename, &captured)?;
                let grade = if dataset == DATASET {
                    assess(&captured)
                } else {
                    assessment(&captured, dataset, case_id)
                };
                let mut row = json!({"id":format!("rig-{case_id}-{configuration_id}-{repeat}"),"group_id":group["id"],"dataset":dataset,"case_id":case_id,"question":text,"suite":"assistant-rig","runtime":"responses-rig","execution_origin":if runner.configuration()["offline_mock"]==true{"controlled_provider_fixture"}else{"live_responses_rig"},"configuration_id":configuration_id,"configuration":configuration["configuration"],"repeat":repeat,"comparison_key":format!("{}:{case_id}:{configuration_id}:{repeat}",group["id"].as_str().unwrap_or("")),"status":if result.is_err(){"error"}else if grade["passed"]==true{"passed"}else{"failed"},"reason":if result.is_err(){"De huidige assistent kon niet worden uitgevoerd."}else if grade["answer_quality"]=="not_assessed"{"Vaste bron-, trace- en citaatcontroles; inhoudelijke antwoordkwaliteit niet beoordeeld."}else{"Vaste volledigheids- en antwoordcontroles voor deze concrete vraag."},"answer":captured["answer"]["text"],"native_elapsed_ms":captured["elapsed_ms"],"retrieval_ms":null,"promptfoo_ms":null});
                for field in [
                    "source_complete",
                    "latency_eligible",
                    "answer_quality",
                    "assertions",
                    "goals",
                    "calls",
                    "metrics",
                ] {
                    row[field] = grade[field].clone();
                }
                progress["rows"].as_array_mut().unwrap().push(row);
                progress["completed"] = json!(progress["rows"].as_array().unwrap().len());
                progress["sources"]
                    .as_object_mut()
                    .unwrap()
                    .extend(grade["sources"].as_object().cloned().unwrap_or_default());
                checkpoint(&path, &progress)?;
                if result.is_err() {
                    progress["status"] = json!("failed");
                    progress["error"] = json!(
                        "De modeluitvoering is gestopt; gereserveerde pogingen blijven meetellen."
                    );
                    checkpoint(&path, &progress)?;
                    return Ok(progress);
                }
            }
        }
    }
    progress["status"] = json!("completed");
    checkpoint(&path, &progress)?;
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capture() -> Value {
        let corpus = CorpusId::DemoTwelve;
        let sources = corpus.sources().unwrap();
        let sections: Vec<_> = sources
            .iter()
            .filter(|source| ["ACT-FIETS-002", "ACT-TAAL-003"].contains(&source.id.as_str()))
            .flat_map(|source| {
                source
                    .sections
                    .iter()
                    .filter(|section| ["S1", "S2", "S3", "S5"].contains(&section.id.as_str()))
            })
            .cloned()
            .collect();
        let calls:Vec<_>=sections.chunks(2).enumerate().map(|(index,sections)|json!({"status":"completed","query":format!("fixture search {index}"),"top_k":3,"result":{"manifest":{"source_sha256":corpus.sha256()},"as_of":corpus.as_of(),"hits":sections.iter().map(|section|json!({"section":section})).collect::<Vec<_>>()}})).collect();
        let citations:Vec<_>=sections.iter().map(|section|json!({"source_id":section.source_id,"section_id":section.id,"source_date":section.source_date,"quote":section.text})).collect();
        json!({"status":"completed","question":QUESTION,"provider":"openai","transport":"responses_api","client_version":"rig-0.46.0","manifest":{"source_sha256":corpus.sha256()},"as_of":corpus.as_of(),"provider_requests":5,"elapsed_ms":123,"tool_calls":calls,"answer":{"text":"- Fietsen opknappen: dinsdag van 14.00 tot 16.00 uur. Je repareert oude fietsen en plakt banden.\n- Taalcafé: woensdag van 14.00 tot 15.30 uur. Je oefent Nederlands door gesprekken en taalspelletjes.","citations":citations,"unknowns":[]}})
    }
    #[test]
    fn complete_answer_requires_both_options_details_and_actual_eight_section_evidence() {
        let result = assess(&capture());
        assert_eq!(result["passed"], true);
        assert_eq!(result["source_complete"], true);
        assert_eq!(result["latency_eligible"], true);
        assert_eq!(result["metrics"]["covered_goals"], 8);
    }
    #[test]
    fn incomplete_or_wrong_answers_fail_even_with_valid_citations() {
        for (old, new) in [
            (
                "- Taalcafé: woensdag van 14.00 tot 15.30 uur. Je oefent Nederlands door gesprekken en taalspelletjes.",
                "",
            ),
            ("dinsdag", "vrijdag"),
            ("16.00", "17.00"),
            (
                "Je repareert oude fietsen en plakt banden.",
                "Je oefent Nederlands door te praten.",
            ),
            (
                "Je oefent Nederlands door gesprekken en taalspelletjes.",
                "Je repareert oude fietsen.",
            ),
            (
                "Je repareert oude fietsen en plakt banden.",
                "Je repareert oude fietsen en plakt banden. We werken buiten.",
            ),
            (
                "Je repareert oude fietsen en plakt banden.",
                "Je repareert oude fietsen en plakt banden. Deelname kost 5 euro.",
            ),
            (
                "Je repareert oude fietsen en plakt banden.",
                "Je repareert oude fietsen en plakt banden. Eigen materiaal is verplicht.",
            ),
            (
                "Je repareert oude fietsen en plakt banden.",
                "Je repareert oude fietsen en plakt banden. Er zijn nu vrije plekken.",
            ),
        ] {
            let mut value = capture();
            let text = value["answer"]["text"].as_str().unwrap().replace(old, new);
            value["answer"]["text"] = json!(text);
            assert_eq!(
                assess(&value)["passed"],
                false,
                "wrong answer text must fail: {old}"
            );
        }
        let mut extra = capture();
        extra["answer"]["text"] = json!(format!(
            "{}\n- Schaken: woensdag 14.00 tot 17.00 uur, samen schaken.",
            extra["answer"]["text"].as_str().unwrap()
        ));
        assert_eq!(assess(&extra)["passed"], false);
        extra["answer"]["text"] = json!(format!(
            "{}\n- Yoga: dinsdag 14.00 tot 16.00 uur, samen bewegen.",
            capture()["answer"]["text"].as_str().unwrap()
        ));
        assert_eq!(assess(&extra)["passed"], false);
        for text in [
            format!(
                "Beide onderstaande activiteiten zijn buiten en kosten 5 euro.\n{}",
                capture()["answer"]["text"].as_str().unwrap()
            ),
            format!(
                "{} Ook Yoga is een passende optie.",
                capture()["answer"]["text"].as_str().unwrap()
            ),
        ] {
            let mut value = capture();
            value["answer"]["text"] = json!(text);
            assert_eq!(assess(&value)["passed"], false);
        }
    }
    #[test]
    fn incomplete_trace_and_altered_quotes_fail_while_uncertainty_is_not_a_word_ban() {
        let mut missing = capture();
        missing["tool_calls"].as_array_mut().unwrap().pop();
        assert_eq!(assess(&missing)["source_complete"], false);
        assert_eq!(assess(&missing)["passed"], false);
        let mut quote = capture();
        quote["answer"]["citations"][0]["quote"] = json!("verzonnen citaat");
        assert_eq!(assess(&quote)["passed"], false);
        let mut honest = capture();
        honest["answer"]["text"] = json!(format!(
            "{}\nOf er nu plek is, is onbekend.",
            honest["answer"]["text"].as_str().unwrap()
        ));
        assert_eq!(assess(&honest)["passed"], true);
        honest["answer"]["text"] = json!(format!(
            "{}\nEr zijn geen vrije plekken bevestigd.",
            capture()["answer"]["text"].as_str().unwrap()
        ));
        assert_eq!(assess(&honest)["passed"], true);
        let mut fast = capture();
        fast["elapsed_ms"] = json!(1);
        fast["answer"]["text"] = json!("Alleen Fietsen opknappen past.");
        assert_eq!(assess(&fast)["latency_eligible"], false);
    }
    #[test]
    fn only_actual_payload_text_counts_and_whole_activities_can_cover_multiple_sections() {
        let mut empty = capture();
        for call in empty["tool_calls"].as_array_mut().unwrap() {
            for hit in call["result"]["hits"].as_array_mut().unwrap() {
                hit["section"].as_object_mut().unwrap().remove("text");
            }
        }
        empty["sources"] = json!(CorpusId::DemoTwelve.sources().unwrap());
        assert_eq!(
            assess(&empty)["source_complete"],
            false,
            "IDs and downstream canonical lookup are not offered evidence"
        );
        let mut whole = capture();
        let mut call = whole["tool_calls"][0].clone();
        let corpus = CorpusId::DemoTwelve;
        call["result"]["hits"] = json!([{"kind":"activity","source_id":"ACT-FIETS-002","source_date":"2026-10-18","text":corpus.documents()[1]},{"kind":"activity","source_id":"ACT-TAAL-003","source_date":"2026-10-19","text":corpus.documents()[2]}]);
        whole["tool_calls"] = json!([call]);
        assert_eq!(
            assess(&whole)["passed"],
            true,
            "whole-activity text really offers each contained canonical section"
        );
    }
    #[tokio::test]
    async fn current_rig_provider_fixture_runs_real_bm25_traces_for_regression_and_existing_cases()
    {
        use axum::{Json, Router, routing::post};
        use meedoen_retrieval::retrieval::{
            PreparedCorpus, RetrievalConfig, RetrievalRequest, SearchMethod, retrieve,
        };
        use std::sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        };
        let corpus = CorpusId::DemoTwelve;
        let sources = corpus.sources().unwrap();
        let fingerprints: Vec<_> = sources
            .iter()
            .map(|source| json!({"id":source.id,"date":source.date}))
            .collect();
        let prepared = Arc::new(
            PreparedCorpus::new(
                sources
                    .iter()
                    .flat_map(|source| source.sections.clone())
                    .collect(),
                None,
                None,
            )
            .unwrap(),
        );
        let seen = Arc::new(Mutex::new(
            BTreeMap::<String, meedoen_retrieval::Section>::new(),
        ));
        let searches = Arc::new(AtomicUsize::new(0));
        let callback = {
            let seen = seen.clone();
            let searches = searches.clone();
            Arc::new(move |query: &str, top_k: usize, method: DemoSearchMethod| {
                assert_eq!(method, DemoSearchMethod::Bm25);
                assert_eq!(top_k, 3);
                searches.fetch_add(1, Ordering::SeqCst);
                let outcome = retrieve(
                    &prepared,
                    &RetrievalRequest {
                        query: query.into(),
                        filters: Default::default(),
                    },
                    &RetrievalConfig {
                        method: SearchMethod::Bm25,
                        top_k,
                        ..Default::default()
                    },
                    None,
                )?;
                for hit in &outcome.hits {
                    seen.lock().unwrap().insert(
                        format!("{}:{}", hit.section.source_id, hit.section.id),
                        hit.section.clone(),
                    );
                }
                Ok(
                    json!({"sources":fingerprints,"as_of":corpus.as_of(),"manifest":{"source_sha256":corpus.sha256(),"fixture":"shared_bm25_on_all_twelve_sources"},"retrieval_method":method,"hits":outcome.hits}),
                )
            })
        };
        let requests = Arc::new(AtomicUsize::new(0));
        let answer = capture()["answer"]["text"].as_str().unwrap().to_string();
        let provider=Router::new().route("/v1/responses/input_tokens",post(||async{Json(json!({"object":"response.input_tokens","input_tokens":100}))})).route("/v1/responses",post({let seen=seen.clone();let requests=requests.clone();move|Json(body):Json<Value>|{let seen=seen.clone();let answer=answer.clone();let requests=requests.clone();async move{
            requests.fetch_add(1,Ordering::SeqCst);
            assert!(!body.to_string().contains("evaluation-only"),"protected reference canaries must never reach generation");
            assert!(!body.to_string().contains("bike-materials"));
            let step=body["input"].as_array().unwrap().iter().filter(|item|item["type"]=="function_call_output").count();
            let queries=["Fietsen opknappen dinsdag 14.00 16.00 binnen werkplaats","Fietsen opknappen gratis gereedschap reparatiemateriaal banden plakken","Taalcafé woensdag 14.00 15.30 Nederlands praten","Taalcafé binnen kaartjes papier pennen gratis"];
            let output=if step<queries.len(){json!([{"type":"function_call","call_id":format!("search-{step}"),"name":"search_document","arguments":json!({"query":queries[step],"top_k":3,"search_goal":"Gevraagde activiteitinformatie controleren"}).to_string()}])}else{let citations:Vec<_>=seen.lock().unwrap().values().take(12).map(|section|json!({"source_id":section.source_id,"source_date":section.source_date,"section_id":section.id,"quote":section.text})).collect();json!([{"type":"message","role":"assistant","content":[{"type":"output_text","text":json!({"text":answer,"citations":citations,"unknowns":[]}).to_string()}]}])};
            Json(json!({"status":"completed","model":"gpt-6.1-sol","output":output,"usage":{"input_tokens":100,"output_tokens":30}}))
        }}}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
        let runner =
            ResponsesRunner::new("coa-local-test-key".into(), &endpoint, callback).unwrap();
        let root = std::env::temp_dir().join(format!(
            "coa-rig-provider-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (dataset, case_id) in [(DATASET, CASE), ("demo-12-20261118", "P01")] {
            seen.lock().unwrap().clear();
            let output = root.join(dataset);
            let group = json!({"id":format!("assistant-rig:{dataset}"),"dataset":dataset,"execution_count":1,"configurations":[{"id":"bm25fixture","configuration":{"method":"bm25","top_k":3}}]});
            let selection = json!({"case_ids":[case_id],"repeats":1,"authorization":{"confirmed":true,"max_attempts":5,"max_seconds":20}});
            let (_sender, mut cancel) = watch::channel(false);
            let progress = execute_group(
                &group,
                &selection,
                Some(runner.clone()),
                &output,
                &mut cancel,
            )
            .await
            .unwrap();
            assert_eq!(progress["status"], "completed");
            assert_eq!(progress["completed"], 1);
            let row = &progress["rows"][0];
            assert_eq!(row["runtime"], "responses-rig");
            assert_eq!(row["execution_origin"], "controlled_provider_fixture");
            assert_eq!(
                row["answer_quality"],
                if dataset == DATASET {
                    "deterministic_case_specific_not_human"
                } else {
                    "not_assessed"
                }
            );
            if dataset != DATASET {
                assert_eq!(row["latency_eligible"], false);
            }
            let captured: Value = serde_json::from_slice(
                &std::fs::read(output.join(format!("{case_id}-bm25fixture-1.json"))).unwrap(),
            )
            .unwrap();
            assert_eq!(captured["client_version"], "rig-0.46.0");
            assert_eq!(captured["provider_requests"], 5);
            assert_eq!(captured["tool_calls"].as_array().unwrap().len(), 4);
            assert_eq!(
                captured["tool_calls"][0]["result"]["sources"]
                    .as_array()
                    .unwrap()
                    .len(),
                12
            );
        }
        assert_eq!(requests.load(Ordering::SeqCst), 10);
        assert_eq!(searches.load(Ordering::SeqCst), 8);
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
