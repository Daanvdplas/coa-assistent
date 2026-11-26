# Local setup

[Project purpose](../README.md) · [Agent instructions](../AGENTS.md) · [Architecture](CODEBASE_GUIDE.md)

This procedure runs the website locally. New answers use your own OpenAI API account. [Evaluation routes](../evals/README.md) have separate Node.js/Codex prerequisites and budgets; the website needs neither.

## Prerequisites

Use macOS or Linux with Git, Bash, a C/C++ build environment and Rust installed through rustup. macOS needs the Xcode Command Line Tools; Ubuntu/Debian commonly needs `build-essential`, `pkg-config` and `libssl-dev`. `rust-toolchain.toml` selects Rust **1.97.1**. The first build and local embedding-model download require internet access.

```sh
git clone https://github.com/Daanvdplas/coa-assistent.git
cd coa-assistent
```

## Preview without model calls

From the repository, explicitly remove inherited provider and budget configuration and disable `.env` loading for this process:

```sh
env -u OPENAI_API_KEY -u COA_OPENAI_API_KEY_FILE -u COA_DEMO_BUDGET_FILE \
  -u COA_OPENAI_ENFORCED_PROJECT_ID -u COA_RESPONSES_TEST_URL \
  -u COA_RESPONSES_TEST_TIMEOUT_MS -u COA_TRACE_DB \
  COA_DISABLE_DOTENV=1 cargo run --locked
```

Open **http://127.0.0.1:8766/** when the server is ready. You can read the twelve fictional sources, technical explanation and saved results; new answers are unavailable. Do not start local evaluation jobs as part of this preview. The first launch builds Rust and downloads approximately 235 MB of MiniLM files to `.model-cache/` in the working directory. Later launches reuse them. Keep the terminal open; **Ctrl+C** stops the server.

## Enable new answers with an approved limit

Before proceeding, agree an explicit positive number of **model attempts** with the user and explain the cost assumptions below. One question can consume up to five attempts; failed attempts count too. There is no default limit. A separate owner's fifty attempts or $100 authorization does not apply to your copy.

### Store your own key

Use an OpenAI API key with access to `gpt-6.1-sol` and available API credit. Never paste the key into chat or a command. From the project root:

```sh
cp -n .env.example .env
chmod 600 .env
```

Open `.env` in your local editor and fill in `OPENAI_API_KEY`. The web app automatically reads this file from its **current working directory**, so start it from the project root. It does not search parent directories. `.env` and `.env.*` are ignored by Git, except the empty `.env.example` template. Do not share or commit the populated file.

Only `OPENAI_API_KEY` is read from `.env`; other settings are not imported into the process environment. An inherited nonempty `OPENAI_API_KEY` takes precedence, followed by an explicit `COA_OPENAI_API_KEY_FILE`, then `.env`. Set `COA_DISABLE_DOTENV=1` to skip `.env`. Missing keys leave source/result browsing available; malformed `.env` files disable new answers with a redacted error. A key alone does not authorize model use: the separately approved persistent budget below is still required.

#### Alternative: external key file

An existing external key file remains supported. Ask the user for its file path, never its contents. To create one, the user can run this Bash block: input is hidden, omitted from command history, and an existing file is never overwritten.

```sh
bash <<'BASH'
set -eu
umask 077
mkdir -p "$HOME/.config/coa"
chmod 700 "$HOME/.config/coa"
printf 'OpenAI API key (hidden): ' >/dev/tty
IFS= read -r -s COA_SETUP_KEY </dev/tty
printf '\n' >/dev/tty
(set -o noclobber; printf '%s\n' "$COA_SETUP_KEY" > "$HOME/.config/coa/openai-api-key")
unset COA_SETUP_KEY
chmod 600 "$HOME/.config/coa/openai-api-key"
BASH
```

The file must be owned by the current user, regular, mode `0600`, and neither a symlink nor a hardlink. Keep this alternative key file outside the repository. An inherited `OPENAI_API_KEY` takes precedence over it.

### Initialize the budget once

Enter only the explicitly approved positive number of model attempts:

```sh
printf 'Approved maximum model attempts: '
IFS= read -r COA_APPROVED_ATTEMPTS
mkdir -p "$HOME/.config/coa/demo-budget"
chmod 700 "$HOME/.config/coa/demo-budget"
cargo run --locked -- demo-budget init "$HOME/.config/coa/demo-budget/attempts-v2.json" --max-attempts "${COA_APPROVED_ATTEMPTS:?Choose an approved positive attempt count}"
```

Initialization refuses an existing file. Keep this file across restarts, updates and rollbacks. Never delete or replace it to renew usage. Missing, corrupt, replaced or unwritable budget state blocks new provider attempts; a second server cannot open the same budget concurrently.

### Start and stop

With `.env` filled in, start from the project root and select the approved budget path:

```sh
env -u OPENAI_API_KEY -u COA_OPENAI_API_KEY_FILE -u COA_DISABLE_DOTENV \
  -u COA_OPENAI_ENFORCED_PROJECT_ID -u COA_RESPONSES_TEST_URL -u COA_RESPONSES_TEST_TIMEOUT_MS \
  COA_DEMO_BUDGET_FILE="$HOME/.config/coa/demo-budget/attempts-v2.json" \
  cargo run --locked
```

For the alternative external key file, use this command instead. Substitute the approved external paths if they differ:

```sh
env -u OPENAI_API_KEY -u COA_OPENAI_ENFORCED_PROJECT_ID \
  -u COA_RESPONSES_TEST_URL -u COA_RESPONSES_TEST_TIMEOUT_MS \
  COA_OPENAI_API_KEY_FILE="$HOME/.config/coa/openai-api-key" \
  COA_DEMO_BUDGET_FILE="$HOME/.config/coa/demo-budget/attempts-v2.json" \
  cargo run --locked
```

Open **http://127.0.0.1:8766/**. Use **Ctrl+C** to stop. Resume with the same command and budget file. Stopping blocks new local work but cannot cancel charges for work the provider has already accepted. Questions and retrieved passages go to OpenAI; use fictional information only. `store: false` is not a zero-retention guarantee.

## Token and price assumptions

Policy 2 reserves each model attempt durably **before** the free input count. Failure, cancellation or a failed count does not refund the reservation. Before every generation, the official count endpoint counts the complete request, including instructions, tools, answer schema and replayed context. Unknown, invalid or excessive counts stop generation; there is no estimate fallback or automatic retry.

The schema-2 budget is tied to Sol, Standard tier, cache TTL `30m`, at most **300,000 counted input tokens** and **4096 output tokens**, including reasoning. A question has at most four searches, five generations and five input counts within one 120-second deadline. Version-1 budgets are refused; there is no automatic conversion or reset. Recalculate and obtain approval before changing model, tier, cache policy, token ceilings, prices or issuance.

Historical price check: the [Standard pricing page](https://developers.openai.com/api/docs/pricing), recorded as updated **17 November 2026**, gave the conservative applicable rates of $5/million input tokens and $15/million output tokens. For **fifty separately approved attempts**, `(300,000 × $5 + 4096 × $15) / 1,000,000 × 50 = $78.072`; one total 20% planning buffer gives **$93.6864**. This static calculation is not a billing ledger, a current price guarantee or an account-wide dollar cap. Verify applicable prices before authorizing a new run. The [input-counting documentation](https://help.openai.com/en/articles/4936856-understanding-and-counting-tokens), recorded as updated around **5 November 2026**, describes the free count route.

## Configuration reference

| Setting | Purpose |
| --- | --- |
| `COA_BENCHMARK_DIR` | Optional private durable benchmark directory; default `evals/benchmark/results/local/`. Do not share it between simultaneously running servers. |
| `COA_PORT` | Local port; default `8766`, for example `COA_PORT=8767 cargo run --locked`. |
| `OPENAI_API_KEY` | Server-side key, inherited or read from working-directory `.env`; never put its value in command arguments. |
| `COA_OPENAI_API_KEY_FILE` | Alternative explicit external provider-key file; takes precedence over `.env`. |
| `COA_DISABLE_DOTENV` | Set to `1` to skip `.env`, including for a credential-free preview. |
| `COA_DEMO_BUDGET_FILE` | Persistent approved schema-2 budget for local answering and benchmark jobs. |
| `COA_OPENAI_ENFORCED_PROJECT_ID` | Dedicated OpenAI project with an enforced monthly spend limit for the [hosted deployment](public-deployment.md#switch-the-hosted-demo-to-an-enforced-openai-project-budget). Leave unset for this setup. |
| `COA_TRACE_DB` | Optional private trace database outside the checkout; unset disables recording. See [local traces](traces.md). |
| `COA_TRUSTED_PROXY_IP` | Exact trusted proxy peer; unset for direct local use. See [deployment](public-deployment.md). |

The server binds to loopback. `/demo` and `/demo/` redirect to `/`; `/techniek/` serves the explanation and `/resultaten/` serves evaluations. `/benchmark/` plans, runs and compares the existing evaluations locally; it requires Node.js/promptfoo for execution and a SQLite build for SQLite profiles. See the [benchmark procedure](../evals/benchmark/README.md). A configured `runtime_ready` flag does not prove provider credit or quota. There is no Codex fallback for web answers.

For code checks, use [AGENTS.md](../AGENTS.md). For retrieval, saved experiments or Codex login/runtime setup, follow the [evaluation index](../evals/README.md) and [Codex bridge](codex.md). For data flows and deletion limits, read [privacy](privacy.md). For publishing, use the separate [deployment procedure](public-deployment.md); local startup does not authorize publication.
