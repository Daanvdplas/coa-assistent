#[path = "../evals/rag/src/legacy.rs"]
mod evaluation;
mod operator_lock;
mod trace_dashboard;
mod web;
use meedoen_retrieval::{DemoSearchMethod, Index};
use std::io::Read;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<_> = std::env::args().skip(1).collect();
    let command = if args.is_empty() {
        "serve".to_string()
    } else {
        args.remove(0)
    };
    match command.as_str() {
        "traces" => {
            trace_dashboard::cli(&args)
                .await
                .map_err(std::io::Error::other)?;
            return Ok(());
        }
        "demo-budget" => {
            meedoen_retrieval::demo_budget::cli(&args)?;
            return Ok(());
        }
        "demo-monthly-budget" => {
            meedoen_retrieval::demo_monthly_budget::cli(&args)?;
            return Ok(());
        }
        "lock-exec" => {
            std::process::exit(operator_lock::run(&args)?);
        }
        "lab" => {
            if args.first().map(String::as_str) == Some("agent-run") {
                meedoen_retrieval::retrieval_lab::agent_run::cli(&args)
                    .await
                    .map_err(std::io::Error::other)?;
                return Ok(());
            }
            if matches!(args.first().map(String::as_str), Some("ask" | "mcp")) {
                meedoen_retrieval::retrieval_lab::live::cli(&args)
                    .await
                    .map_err(std::io::Error::other)?;
                return Ok(());
            }
            let output =
                meedoen_retrieval::retrieval_lab::cli::cli(&args).map_err(std::io::Error::other)?;
            println!("{}", serde_json::to_string_pretty(&output)?);
            return Ok(());
        }
        "experiment" => {
            meedoen_retrieval::experiment::cli(&args)
                .await
                .map_err(std::io::Error::other)?;
            return Ok(());
        }
        "mcp" => {
            let corpus = parse_corpus(&mut args).map_err(std::io::Error::other)?;
            let method = parse_method(&mut args, false).map_err(std::io::Error::other)?;
            if !args.is_empty() {
                return Err(
                    "Usage: mcp [--corpus baseline-five|expanded-ten|demo-twelve] [--method dense|bm25]".into(),
                );
            }
            let mut index: Option<Index> = None;
            meedoen_retrieval::mcp::serve_with_policy(
                std::io::stdin().lock(),
                std::io::stdout().lock(),
                |query, top_k| {
                    if index.is_none() {
                        index = Some(Index::load_for_corpus(corpus)?);
                    }
                    let index = index.as_mut().unwrap();
                    match method {
                        Some(method) => index.search_for_method(query, top_k, method),
                        None => serde_json::to_value(index.search_with_top_k(query, top_k)?)
                            .map_err(|error| error.to_string()),
                    }
                },
                match method {
                    Some(method) => {
                        meedoen_retrieval::mcp::SearchPolicy::for_demo_method(corpus, method)
                    }
                    None => meedoen_retrieval::mcp::SearchPolicy::for_corpus(corpus),
                },
            )
            .map_err(std::io::Error::other)?;
            return Ok(());
        }
        "ask" => {
            let corpus = parse_corpus(&mut args).map_err(std::io::Error::other)?;
            let top_k = parse_top_k(&mut args).map_err(std::io::Error::other)?;
            let runner =
                meedoen_retrieval::codex::CodexRunner::new().map_err(std::io::Error::other)?;
            let result = runner
                .run_for_corpus(&args.join(" "), top_k, corpus)
                .await
                .map_err(std::io::Error::other)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            return Ok(());
        }
        "search" | "eval" => {
            if command == "eval" {
                eprintln!(
                    "Legacy evaluator for historical compatibility. Run new RAG evaluations with npm run eval:rag -- --suite garden."
                );
            }
            let corpus = if command == "search" {
                parse_corpus(&mut args).map_err(std::io::Error::other)?
            } else {
                meedoen_retrieval::corpus::CorpusId::BaselineFive
            };
            let method = if command == "search" {
                parse_method(&mut args, true).map_err(std::io::Error::other)?
            } else {
                None
            };
            let top_k = parse_top_k(&mut args).map_err(std::io::Error::other)?;
            if command == "eval" && !args.is_empty() {
                return Err("Usage: eval [--top-k 1..6]".into());
            }
            let queries = if command == "search" {
                Some(
                    parse_search_queries(&args, std::io::stdin().lock())
                        .map_err(std::io::Error::other)?,
                )
            } else {
                None
            };
            if method == Some(DemoSearchMethod::Guided)
                && corpus != meedoen_retrieval::corpus::CorpusId::DemoTwelve
            {
                return Err("Guided search requires --corpus demo-twelve".into());
            }
            let mut index = Index::load_for_corpus(corpus).map_err(std::io::Error::other)?;
            let mut search = |question: &str| {
                match method {
                    Some(method) => index.search_for_method(question, top_k, method),
                    None => index.search_with_top_k(question, top_k).and_then(|result| {
                        serde_json::to_value(result).map_err(|error| error.to_string())
                    }),
                }
                .map_err(std::io::Error::other)
            };
            let output = match queries {
                Some(SearchQueries::Single(question)) => search(&question)?,
                Some(SearchQueries::Batch(questions)) => serde_json::Value::Array(
                    questions
                        .iter()
                        .map(|question| search(question))
                        .collect::<Result<_, _>>()?,
                ),
                None => evaluation::run(&mut index, top_k).map_err(std::io::Error::other)?,
            };
            println!("{}", serde_json::to_string_pretty(&output)?);
            return Ok(());
        }
        "serve" if args.is_empty() => {}
        _ => {
            return Err(
                "Usage: [serve | search [--corpus ID] [--method dense|bm25|guided] [--top-k 1..6] (QUESTION | --queries-stdin) | eval [--top-k 1..6] | mcp | ask [--top-k 1..6] QUESTION]".into(),
            );
        }
    }
    let index = Index::load_for_corpus(meedoen_retrieval::corpus::CorpusId::DemoTwelve)
        .map_err(std::io::Error::other)?;
    web::serve(index).await
}

#[derive(Debug, PartialEq, Eq)]
enum SearchQueries {
    Single(String),
    Batch(Vec<String>),
}

fn parse_search_queries(args: &[String], input: impl Read) -> Result<SearchQueries, String> {
    if !args.iter().any(|arg| arg == "--queries-stdin") {
        return meedoen_retrieval::validate_query(&args.join(" ")).map(SearchQueries::Single);
    }
    if args.len() != 1 {
        return Err("Use --queries-stdin once instead of a positional question".into());
    }

    const MAX_BYTES: usize = 64 * 1024;
    let mut bytes = Vec::new();
    input
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read search queries from stdin: {error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("Search queries on stdin exceed 64 KiB".into());
    }
    let queries: Vec<String> = serde_json::from_slice(&bytes)
        .map_err(|_| "Expected a JSON array of search questions on stdin")?;
    if !(1..=64).contains(&queries.len()) {
        return Err("Expected 1 to 64 search queries on stdin".into());
    }
    queries
        .iter()
        .map(|query| meedoen_retrieval::validate_query(query))
        .collect::<Result<_, _>>()
        .map(SearchQueries::Batch)
}

fn parse_corpus(args: &mut Vec<String>) -> Result<meedoen_retrieval::corpus::CorpusId, String> {
    if args.iter().filter(|arg| arg.as_str() == "--corpus").count() > 1 {
        return Err("Duplicate --corpus option".into());
    }
    let Some(position) = args.iter().position(|arg| arg == "--corpus") else {
        return Ok(meedoen_retrieval::corpus::CorpusId::BaselineFive);
    };
    let id = args.get(position + 1).ok_or("Missing --corpus value")?;
    let corpus = serde_json::from_value(serde_json::Value::String(id.clone()))
        .map_err(|_| "Select --corpus baseline-five, expanded-ten or demo-twelve")?;
    args.drain(position..=position + 1);
    Ok(corpus)
}

fn parse_method(
    args: &mut Vec<String>,
    allow_guided: bool,
) -> Result<Option<DemoSearchMethod>, String> {
    if args.iter().filter(|arg| arg.as_str() == "--method").count() > 1 {
        return Err("Duplicate --method option".into());
    }
    let Some(position) = args.iter().position(|arg| arg == "--method") else {
        return Ok(None);
    };
    let value = args.get(position + 1).ok_or("Missing --method value")?;
    let method = match value.as_str() {
        "dense" => DemoSearchMethod::Dense,
        "bm25" => DemoSearchMethod::Bm25,
        "guided" if allow_guided => DemoSearchMethod::Guided,
        _ if allow_guided => return Err("Select --method dense, bm25 or guided".into()),
        _ => return Err("Select --method dense or bm25".into()),
    };
    args.drain(position..=position + 1);
    Ok(Some(method))
}

fn parse_top_k(args: &mut Vec<String>) -> Result<usize, String> {
    if args.iter().filter(|arg| arg.as_str() == "--top-k").count() > 1 {
        return Err("Duplicate --top-k option".into());
    }
    let Some(position) = args.iter().position(|arg| arg == "--top-k") else {
        return Ok(meedoen_retrieval::DEFAULT_TOP_K);
    };
    let value = args
        .get(position + 1)
        .ok_or("Missing --top-k value")?
        .parse()
        .map_err(|_| "Expected an integer for --top-k")?;
    meedoen_retrieval::ranking::validate_top_k(value)?;
    args.drain(position..=position + 1);
    Ok(value)
}
#[cfg(test)]
mod cli_tests {
    use super::*;
    #[test]
    fn stdin_search_requires_bounded_valid_questions_before_loading_the_index() {
        let stdin = ["--queries-stdin".into()];
        assert_eq!(
            parse_search_queries(&stdin, br#"["Waar?", "Wanneer?"]"#.as_slice()).unwrap(),
            SearchQueries::Batch(vec!["Waar?".into(), "Wanneer?".into()])
        );
        assert_eq!(
            parse_search_queries(&stdin, b"[]".as_slice()).unwrap_err(),
            "Expected 1 to 64 search queries on stdin"
        );
        for bytes in [
            b"{}".to_vec(),
            br#"["Waar?", ""]"#.to_vec(),
            serde_json::to_vec(&vec!["Waar?"; 65]).unwrap(),
            vec![b' '; 64 * 1024 + 1],
        ] {
            assert!(parse_search_queries(&stdin, bytes.as_slice()).is_err());
        }
        assert!(
            parse_search_queries(&[stdin[0].clone(), "Waar?".into()], b"[]".as_slice()).is_err()
        );
        assert_eq!(
            parse_search_queries(&["Waar?".into()], b"[]".as_slice()).unwrap(),
            SearchQueries::Single("Waar?".into())
        );
    }

    #[test]
    fn guided_search_flag_is_local_to_search_command() {
        let mut args = vec!["--method".into(), "guided".into(), "Waar?".into()];
        assert_eq!(
            parse_method(&mut args, true).unwrap(),
            Some(DemoSearchMethod::Guided)
        );
        assert_eq!(args, ["Waar?"]);
        assert!(parse_method(&mut vec!["--method".into(), "guided".into()], false).is_err());
        assert!(parse_method(&mut vec!["--method".into(), "other".into()], true).is_err());
        assert_eq!(parse_method(&mut args, true).unwrap(), None);
    }

    #[test]
    fn explicit_corpus_selection_preserves_question_and_legacy_default() {
        let mut args = vec!["--corpus".into(), "expanded-ten".into(), "Wanneer?".into()];
        assert_eq!(
            parse_corpus(&mut args).unwrap(),
            meedoen_retrieval::corpus::CorpusId::ExpandedTen
        );
        assert_eq!(args, ["Wanneer?"]);
        assert_eq!(
            parse_corpus(&mut args).unwrap(),
            meedoen_retrieval::corpus::CorpusId::BaselineFive
        );
        assert!(parse_corpus(&mut vec!["--corpus".into(), "other".into()]).is_err());
        assert!(parse_corpus(&mut vec!["--corpus".into()]).is_err());
        assert!(
            parse_corpus(&mut vec![
                "--corpus".into(),
                "expanded-ten".into(),
                "--corpus".into(),
                "baseline-five".into()
            ])
            .is_err()
        );
    }
    #[test]
    fn parses_bounded_k_without_losing_question_text() {
        let mut args = vec!["--top-k".into(), "2".into(), "Where?".into()];
        assert_eq!(parse_top_k(&mut args).unwrap(), 2);
        assert_eq!(args, ["Where?"]);
        for value in ["0", "7", "oops"] {
            assert!(parse_top_k(&mut vec!["--top-k".into(), value.into()]).is_err());
        }
        assert!(parse_top_k(&mut vec!["--top-k".into()]).is_err());
    }
}
