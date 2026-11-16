//! Explicit local evaluation encoders; the live assistant keeps its own default.
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    str::FromStr,
    sync::OnceLock,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ModelChoice {
    #[default]
    MiniLm,
    E5Small,
}

#[derive(Debug, Deserialize)]
pub struct ModelSpec {
    pub id: String,
    pub label: String,
    pub repository: String,
    pub model_file: String,
    pub dimensions: usize,
    pub sdk: String,
    pub max_tokens: usize,
    pub document_prefix: String,
    pub query_prefix: String,
    pub encoding: String,
}

impl ModelChoice {
    pub fn all() -> [Self; 2] {
        [Self::MiniLm, Self::E5Small]
    }
    pub fn id(self) -> &'static str {
        match self {
            Self::MiniLm => "minilm-multilingual",
            Self::E5Small => "e5-small-multilingual",
        }
    }
    pub fn spec(self) -> &'static ModelSpec {
        static MODELS: OnceLock<Vec<ModelSpec>> = OnceLock::new();
        MODELS
            .get_or_init(|| {
                serde_json::from_str(include_str!("../embedding-models.json"))
                    .expect("Validated embedded model catalog")
            })
            .iter()
            .find(|model| model.id == self.id())
            .expect("Every allowed encoder has a catalog entry")
    }
    pub fn sdk_model(self) -> fastembed::EmbeddingModel {
        match self {
            Self::MiniLm => fastembed::EmbeddingModel::ParaphraseMLMiniLML12V2Q,
            Self::E5Small => fastembed::EmbeddingModel::MultilingualE5Small,
        }
    }
    pub fn repository_cache(self, cache: &Path) -> PathBuf {
        cache.join(format!(
            "models--{}",
            self.spec().repository.replace('/', "--")
        ))
    }
    pub fn files(self) -> Vec<&'static str> {
        vec![
            self.spec().model_file.as_str(),
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "special_tokens_map.json",
        ]
    }
    pub fn cached(self, cache: &Path) -> bool {
        let base = self.repository_cache(cache);
        let Ok(revision) = std::fs::read_to_string(base.join("refs/main")) else {
            return false;
        };
        let revision = revision.trim();
        revision.len() == 40
            && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
            && self.files().iter().all(|file| {
                base.join("snapshots")
                    .join(revision)
                    .join(file)
                    .metadata()
                    .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
            })
    }
}
impl FromStr for ModelChoice {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::all()
            .into_iter()
            .find(|choice| choice.id() == value)
            .ok_or_else(|| "Unknown local evaluation embedding model".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_or_empty_model_files_are_not_reported_as_cached() {
        let root = std::env::temp_dir().join(format!(
            "coa-encoder-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let model = ModelChoice::E5Small;
        let base = model.repository_cache(&root);
        std::fs::create_dir_all(base.join("refs")).unwrap();
        let revision = "a".repeat(40);
        std::fs::write(base.join("refs/main"), &revision).unwrap();
        for name in model.files() {
            let path = base.join("snapshots").join(&revision).join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"fixture").unwrap();
        }
        assert!(model.cached(&root));
        let weights = base
            .join("snapshots")
            .join(&revision)
            .join(&model.spec().model_file);
        std::fs::write(&weights, b"").unwrap();
        assert!(
            !model.cached(&root),
            "A cancelled/empty weight download must not be advertised as ready"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn catalog_matches_actual_pinned_sdk_models_and_rejects_arbitrary_identifiers() {
        for model in ModelChoice::all() {
            let sdk_model = model.sdk_model();
            let sdk = fastembed::TextEmbedding::get_model_info(&sdk_model).unwrap();
            assert_eq!(sdk.model_code, model.spec().repository);
            assert_eq!(sdk.model_file, model.spec().model_file);
            assert_eq!(sdk.dim, model.spec().dimensions);
            assert_eq!(model.id().parse::<ModelChoice>().unwrap(), model);
        }
        assert!(
            "https://untrusted.invalid/model"
                .parse::<ModelChoice>()
                .is_err()
        );
        assert_ne!(
            ModelChoice::MiniLm.spec().repository,
            ModelChoice::E5Small.spec().repository
        );
        assert_eq!(ModelChoice::E5Small.spec().document_prefix, "passage: ");
        assert_eq!(ModelChoice::E5Small.spec().query_prefix, "query: ");
    }
}
