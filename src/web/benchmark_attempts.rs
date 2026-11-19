//! Read-only annotations for retained failed native preparations missing from old projections.
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

fn read(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > 2 * 1024 * 1024 {
        return None;
    }
    fs::read_to_string(path).ok()
}
fn directories(path: &Path, prefix: &str) -> Vec<PathBuf> {
    if !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir()) {
        return Vec::new();
    }
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .take(500)
        .filter(|entry| {
            entry.file_name().to_string_lossy().starts_with(prefix)
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
        })
        .map(|entry| entry.path())
        .collect()
}
pub(super) fn enrich(directory: &Path, snapshot: &mut Value) {
    let mut errors = BTreeMap::new();
    if !snapshot["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|group| group["suite"] == "browser" && group["status"] == "failed")
    {
        snapshot["result"]["attempt_errors"] = json!([]);
        return;
    }
    if let Some(id) = snapshot["id"].as_str().filter(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        let root = directory.join(id);
        for part in directories(&root, "browser-") {
            let Some(repeat) = part
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.rsplit('-').next())
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|repeat| {
                    *repeat > 0
                        && Some(*repeat) <= snapshot["plan"]["selection"]["repeats"].as_u64()
                })
            else {
                continue;
            };
            let Some(input) = read(&part.join("browser-inputs.json"))
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            else {
                continue;
            };
            let Some(tests) = input["tests"].as_array().filter(|tests| tests.len() == 1) else {
                continue;
            };
            let vars = &tests[0]["vars"];
            for group in snapshot["groups"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|group| {
                    group["suite"] == "browser"
                        && group["status"] == "failed"
                        && group["dataset"] == vars["dataset"]
                })
            {
                let Some(corpus_hash) = group["identity"]["corpus_sha256"]
                    .as_str()
                    .filter(|hash| !hash.is_empty())
                else {
                    continue;
                };
                let Some(configuration) = group["configurations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|configuration| {
                        configuration["configuration"]
                            .as_object()
                            .is_some_and(|settings| {
                                settings
                                    .iter()
                                    .all(|(key, value)| vars.get(key) == Some(value))
                            })
                    })
                else {
                    continue;
                };
                let (Some(group_id), Some(config_id), Some(case_id)) = (
                    group["id"].as_str(),
                    configuration["id"].as_str(),
                    vars["case_id"].as_str(),
                ) else {
                    continue;
                };
                let key = format!("{group_id}:{case_id}:{config_id}:{repeat}");
                if snapshot["result"]["rows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|row| {
                        row["group_id"] == group_id
                            && row["configuration_id"] == config_id
                            && row["case_id"] == case_id
                            && row["repeat"] == repeat
                    })
                {
                    continue;
                }
                for prepared in directories(&part, "prepared-") {
                    let Some(text) = read(&prepared.join("native.jsonl")) else {
                        continue;
                    };
                    for native in text
                        .lines()
                        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    {
                        if native["execution_status"] != "failed"
                            || !native["outcome"].is_null()
                            || native["case_id"] != case_id
                            || native["dataset"]["corpus_sha256"].as_str() != Some(corpus_hash)
                            || native["config"]["profile"] != vars["profile"]
                            || native["config"]["retrieval"]["method"] != vars["method"]
                            || native["config"]["retrieval"]["top_k"] != vars["top_k"]
                        {
                            continue;
                        }
                        let Some(reason) = native["error"].as_str() else {
                            continue;
                        };
                        if native["run_id"].as_str().is_none_or(|id| {
                            id.is_empty()
                                || id.len() > 512
                                || !id.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte)
                                })
                        }) {
                            continue;
                        }
                        let lower = reason.to_ascii_lowercase();
                        let (code, message) = if lower.contains("onnx")
                            && lower.contains("compil")
                            && lower.contains("i/o")
                        {
                            (
                                "onnx_model_compile_io",
                                "Het ONNX-model kon niet worden gecompileerd (I/O-fout).",
                            )
                        } else {
                            (
                                "local_preparation_failed",
                                "De lokale voorbereiding is mislukt; de bronzoekactie is niet afgerond.",
                            )
                        };
                        errors.insert(key.clone(),json!({"group_id":group_id,"configuration_id":config_id,"repeat":repeat,"comparison_key":key,"case_id":case_id,"dataset":vars["dataset"],"question":vars["question"],"suite":"browser","configuration":configuration["configuration"],"status":"error","execution_status":"failed","attempted":true,"identified_from":"retained_native_preparation","error":{"code":code,"message":message,"stage":"local_preparation"},"reason":message,"native_run_id":native["run_id"],"source_complete":null,"calls":[],"goals":[],"metrics":{},"actual_retrieval":{"activities":null,"sections":null,"applicable":null},"required_source_coverage":{"found":null,"total":null,"unit":"sections","applicable":null}}));
                    }
                }
            }
        }
    }
    snapshot["result"]["attempt_errors"] = json!(errors.into_values().collect::<Vec<_>>());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn a_retained_failed_preparation_is_distinct_from_finished_and_unstarted_measurements() {
        let directory = std::env::temp_dir().join(format!(
            "coa-attempt-projection-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let part = directory.join("test/browser-corpus-49-1");
        std::fs::create_dir_all(part.join("prepared-test")).unwrap();
        let vars = json!({"dataset":"demo","case_id":"P01","question":"Waar kan ik tuinieren?","method":"dense","profile":"documents_sections","top_k":5,"embedding_model":"e5-small-multilingual"});
        let native = json!({"run_id":"failed-native","case_id":"P01","dataset":{"corpus_sha256":"corpus"},"config":{"profile":"documents_sections","retrieval":{"method":"dense","top_k":5}},"execution_status":"failed","outcome":null,"error":"Preparation failed: ONNX runtime error: Error compiling model: compiler I/O error /private/path"});
        std::fs::write(
            part.join("browser-inputs.json"),
            serde_json::to_vec(&json!({"tests":[{"vars":vars}]})).unwrap(),
        )
        .unwrap();
        std::fs::write(
            part.join("prepared-test/native.jsonl"),
            serde_json::to_vec(&native).unwrap(),
        )
        .unwrap();
        let original_row = json!({"group_id":"browser:demo","case_id":"P01","configuration_id":"minilm","repeat":1,"status":"failed","source_complete":false});
        let mut value = json!({"id":"test","status":"failed","plan":{"selection":{"repeats":2}},"progress":{"completed":1,"total":14},"groups":[{"id":"browser:demo","suite":"browser","dataset":"demo","status":"failed","identity":{"corpus_sha256":"corpus"},"configurations":[{"id":"e5","configuration":{"method":"dense","profile":"documents_sections","top_k":5,"embedding_model":"e5-small-multilingual"}}]}],"result":{"rows":[original_row.clone()],"sources":{}}});
        enrich(&directory, &mut value);
        assert_eq!(value["result"]["rows"], json!([original_row]));
        assert_eq!(value["progress"]["completed"], 1);
        let errors = value["result"]["attempt_errors"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0]["repeat"], 1);
        assert_eq!(errors[0]["configuration_id"], "e5");
        assert_eq!(errors[0]["status"], "error");
        assert_eq!(errors[0]["error"]["code"], "onnx_model_compile_io");
        assert!(
            !serde_json::to_string(&errors)
                .unwrap()
                .contains("/private/path")
        );
        // A future explicit error row is not duplicated as a historical annotation.
        value["result"]["rows"]
            .as_array_mut()
            .unwrap()
            .push(errors[0].clone());
        enrich(&directory, &mut value);
        assert!(
            value["result"]["attempt_errors"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
