# COA Assistent

COA Assistent helps a staff member explore suitable activities with a resident. Ask a question about twelve fictional activities, then check the source passages behind the answer.

For example: “Which indoor activity can I join on Tuesday, and where and when does it take place?” The assistant searches the activity descriptions and may search again for missing details. Local multilingual embeddings or BM25 find passages; OpenAI Sol, through Rig, writes the answer. Each suggestion retains its source and date.

This is an independent prototype, not an official COA product. Use fictional information only: questions and retrieved passages are sent to OpenAI. Participation remains voluntary; the staff member checks the evidence and discusses options with the resident. Missing or outdated information stays unknown. The demo changes no records, sends no messages and enrolls nobody.

## Try it with your coding agent

Clone or open this repository in your coding agent and ask:

> Read AGENTS.md and help me run COA Assistent locally. First show the website and saved evaluations without making model calls. Before enabling new answers, ask me for the path to my own API key file and an explicit spending or model-attempt limit. Explain the expected cost and get my approval before spending anything.

The website needs macOS or Linux and Rust 1.97.1. New answers also need your own OpenAI API key and API credit; Node.js and Codex are only needed for evaluation routes. The agent can check your environment and follow the [local setup](docs/LOCAL_SETUP.md). Copy [`.env.example`](.env.example) to `.env`, enter your key locally, and start from the project root; an external key file is also supported. Keep the key out of chat and Git. New answers still require a separately approved budget.

The [code tour](docs/code-tour.html) explains how the parts work together. The [runtime report](docs/runtime-report.md) records what was verified and what remains uncertain. [Evaluations](evals/README.md) distinguish retrieval from the complete assistant; saved results are not human validation of answer quality.

The optional [local trace dashboard](docs/traces.md) records model and search steps in a private SQLite file, groups runs by thread and exports thread JSON for inspection.
