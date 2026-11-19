# Agent instructions

Read [README.md](README.md) for the human purpose and limits. This independent prototype explores a small, explainable agent harness for finding activities. Its current website uses twelve fictional activities, local retrieval and OpenAI Sol through Rig; CLI/model evaluations use Codex separately. Do not expand the scope without a new request.

## Find the right context

| Task | Canonical documentation |
| --- | --- |
| Install, configure, start or stop locally | [Local setup](docs/LOCAL_SETUP.md) |
| Understand architecture, request flow and source contracts | [Codebase guide](docs/CODEBASE_GUIDE.md), [interactive code tour](docs/code-tour.html) and [technical page](static/site/technical.html) |
| Check verified behavior and remaining limits | [Runtime report](docs/runtime-report.md) |
| Understand data flows, retention and cleanup | [Privacy](docs/privacy.md) |
| Prepare hosting, release, stop or roll back | [Public deployment](docs/public-deployment.md) |
| Use the Codex/MCP runtime or a selected retrieval configuration | [Codex bridge](docs/codex.md), [selected-search procedure](docs/retrieval-codex.md) |
| Run or inspect evaluations | [Evaluation index](evals/README.md), routing to retrieval, complete-assistant and shared-dataset documentation |

Follow the selected index to its procedure and metric definitions before running an experiment. Keep documentation, code paths and diagrams accurate in the same change. Frozen datasets, manifests, provenance and results retain their original bytes, including archived prose and paths. Functional source text, evaluation questions and literal quotes keep their original language; authored project documentation is English.

## Start and verify

Investigate the local environment and resolve routine setup issues within the request. Start with `cargo run --locked` without credentials or a budget to inspect the website and saved results without new answers. If the environment already contains credentials or a budget, explicitly remove those settings for that process; see [the safe preview command](docs/LOCAL_SETUP.md#preview-without-model-calls).

For ordinary Rust changes, use `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` and `cargo build --locked`. RAG tooling also has `npm run typecheck` and `npm run test:rag`; follow its guide for prerequisites. Use meaningful checks for the change. Live/model checks are separate and require explicit authorization and limits.

For UI changes, serve locally and have an independent agent use the real browser flow, including mobile and keyboard behavior. Do not use the `dev-browser` skill or CLI, including through another agent. Use little color, only when it communicates meaning or status.

## Credentials and spending

Ask for the user's own API key **file path**, never the key value. Keep secrets out of chat, Git, command arguments, browser data and reports. Do not inspect private key/authentication files. The web app reads only `OPENAI_API_KEY` from `.env` in its working directory as a fallback after inherited key/key-file settings. Set `COA_DISABLE_DOTENV=1` for a credential-free preview; see the safe preview command above. Never put budgets or spending authorization in `.env`.

Before any new model use, obtain an explicit positive model-attempt limit or spending authorization and explain the applicable cost assumptions. A monetary limit must be converted into a bounded attempt count using verified model prices and token limits; it is not a provider-enforced dollar cap. There is no default budget. Other owners' fifty-attempt/$100 examples are not authorization.

Initialize the approved budget once and keep the same ledger when resuming, restarting or updating. Never delete, replace, reset or silently extend it. Reservations are atomic and durable before each attempt; failed or uncertain attempts count. Missing, corrupt, replaced or inaccessible state must fail closed. Preserve policy 2: exact input-token preflight before each generation, fixed model/tier/cache policy, input/output ceilings and schema-2 budget compatibility. Recheck static price inputs before changing those assumptions. Use the separate documented Codex ledgers for evaluation sessions; a session may contain several provider requests.

## Product and repository boundaries

- Use only fictional resident and activity data. Public COA information is background, not evidence of an official or internal COA plan; local practice may differ.
- Preserve source and date for suggestions. Missing or outdated facts remain unknown. Participation is voluntary; a staff member discusses options with the resident. No record changes, messages or enrollment.
- Keep evaluation expectations out of search indexes, generation prompts and stop decisions. Exact citations prove provenance, not answer correctness. Human labels stay empty until supplied by a person.
- Use Rust for the application and TypeScript for owned evaluation tools/scripts. Add no Python code or runtime requirement. Preserve existing browser JavaScript and historical evidence; framework migrations need a separate request.
- Use only sources published or demonstrably updated in 2026 for agent-platform/AI-engineering choices; give each publication/update date and recheck platform assumptions.
- Work on a branch and pull request, never commit directly to `main`. Use independent review; do not merge without explicit user permission. Commits are unsigned by design (`commit.gpgsign=false`). Do not alter unrelated worktrees, hosting, tunnels or provider/account settings.
