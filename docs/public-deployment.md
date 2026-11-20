# Public demo: release, verify and stop

This is an operator procedure, not authorization to deploy. The [runtime report](runtime-report.md) records the **17 November 2026** public launch; this document does not recheck the current host, URL, allowance or service state. The launch used the temporary Cloudflare route below. New deployment or paid verification requires approval of the exact release, URL, separate project key and total allowance. Use fictional information only.

The original owner approved $100 and fifty schema-2 model attempts under **policy 2**. Before each attempt, the official free endpoint counts the exact complete input, at most 300,000 tokens; output is at most 4096 tokens. At the Sol/Standard/30m price assumptions recorded **17 November 2026**, fifty attempts give a conservative $78.072, or $93.6864 with one total 20% planning margin. This is not an account-wide billing guarantee or a default allowance for another installation. Recalculate before changing model, tier, cache policy, token ceilings, prices or issuance. Keep keys and real resident data out of Git, commands, issues and logs.

## Host and route history

A read-only check on **16 November 2026** found an existing Ubuntu 24.04 x86_64 Hetzner VPS, two vCPUs, approximately 3 GiB available RAM, no swap and 45 GiB free disk. `/var/lib/coa-demo` existed with mode `0700`; `/opt/coa-demo` was initially empty and root-owned. These are historical observations, not live capacity checks. Preserve SSH, private Tailscale routing and unrelated services.

The initial proposed permanent route was HTTPS on the public IP, without a domain purchase: Caddy explicitly uses Let's Encrypt's `shortlived` ACME profile, not a locally trusted IP certificate. Public ports were unreachable in the concrete trial despite working local Caddy listeners; firewall management and Funnel-owner authorization were unavailable. Do not change broad firewall/Tailscale settings to work around this. The temporary tunnel was the approved alternative. Recheck prerequisites before selecting a new route.

## Build one pinned Linux package

The **Public demo release candidate** workflow builds Ubuntu 24.04/Rust 1.97.1 with `Cargo.lock`. It creates a downloadable review artifact, has no server/provider credentials and deploys nothing. Run it on the approved branch and check that its actual commit equals the approved release.

The package contains:

- `bin/meedoen-retrieval`: Linux x86_64 release, not a Mac executable.
- `lib/`: runtime libraries not supplied by the target Ubuntu baseline, discovered with `ldd`.
- `release.json` and `SHA256SUMS`: source commit, toolchain, lockfile hash and checksums.
- `config/`: packaged proxy/service configuration from repository [deploy/](../deploy/); `DEPLOYMENT.md`: this procedure.

The binary embeds sources, UI and selected saved reports. The website service needs no Node, npm, Codex, Git, personal caches or full checkout. Verify system libraries with `ldd`. The workflow tests proxy behavior, checksums, CLI, systemd parsing and real MiniLM warmup with an unusable test key and no answer calls. It rejects a binary without mandatory budget enforcement. This is not a VPS capacity guarantee.

Verify the downloaded archive's outer `.sha256`, extract into a new directory, then run `sha256sum --check SHA256SUMS` there. Retain source commit and workflow-run identity. Install root-owned under `/opt/coa-demo/releases/APPROVED_COMMIT`; switch `current` only when activating that verified release. Never overwrite an active release.

## Private key and persistent state

These are operator actions **after approval**, never automatic startup/restart steps:

1. Create `/var/lib/coa-demo/budget`, owner `coa-demo:coa-demo`, mode `0700`.
2. Store the separate project key in `/var/lib/coa-demo/openai-api-key`, owned by `coa-demo`, regular, mode `0600`, with no symlink/hardlink. Do not copy personal Codex authentication or put the value in arguments/environment files.
3. Initialize once as `coa-demo`: `meedoen-retrieval demo-budget init /var/lib/coa-demo/budget/attempts-v2.json --max-attempts APPROVED_COUNT`. The placeholder is deliberately invalid; substitute only the approved count. Initialization must refuse an existing file. Keep state outside releases and across restart/rollback.

Never delete/rewrite budget state to repair an error. Missing, invalid or inaccessible state must block provider attempts. The service initializes nothing and has no default cap. Network-address limits are additional RAM counters, not spending state.

Historical migration: an earlier private preparation had an unused schema-1 allowance of fifteen. Only its explicitly verified zero-use state authorized a one-time transition: stop service, preserve the old file unchanged as audit evidence, remove service access (`root:root`, `0400`) and initialize a **new** v2 path with the new binary. Never change the old cap/counter. Any use requires a new combined remaining-budget decision. Older binaries refuse v2; never roll back to an old unit plus the unused v1 budget, which would open a second allowance. This history does not authorize a new migration.

## Service and model warmup behind closed access

Install packaged `config/coa-demo.service` as `/etc/systemd/system/coa-demo.service`. It runs as `coa-demo`, with read-only code, private temporary files, hidden personal home directories and write access only under `/var/lib/coa-demo`. Key/budget paths are fixed; Rust listens only on `127.0.0.1:8766`.

`MemoryMax=1536M` is a configured ceiling, not proven sustained capacity. Warm MiniLM from the service working directory so its approximately 235 MB model cache stays under `/var/lib/coa-demo`. Startup embeds 72 fictional sections using two CPU threads; answer generation runs externally. Do not copy personal cache collections.

After `systemctl daemon-reload` and `systemctl start coa-demo.service`, retain private-only access until checks pass:

- `ldd` with `LD_LIBRARY_PATH=/opt/coa-demo/current/lib` shows no missing library.
- `/api/source` exposes twelve intended sources/reference date, real provider configuration and `runtime_ready=true`, without a mock route. Readiness alone does not prove quota/credit.
- Warmup and systemd `MemoryCurrent`/`MemoryPeak` show no OOM or restart loop. Insufficient resources keep publication blocked.
- Verify key/state ownership and modes, and fail-closed behavior for missing/corrupt budget state using isolated test state rather than damaging the live ledger.

Log only safe status/operational diagnostics. Do not enable body, authorization-header, question/answer or session logging. The supplied Caddy config has no access log and removes the whole request object from its default logger: upstream failures must not log the `X-Test-Session` bearer token. Proxy tests force that failure with a synthetic canary. `store: false` does not promise zero provider retention.

## Permanent HTTPS route

Proxy tests pin **Caddy 2.11.9**, published **5 November 2026**. Install packaged `config/Caddyfile` as `/etc/caddy/Caddyfile`, and `config/caddy-override.conf` as `/etc/systemd/system/caddy.service.d/coa-demo.conf`. Create root-owned `/etc/coa-demo/public.env` (`0600`) from `config/public.env.example`, containing only the approved public IP, without scheme/path. Missing host configuration fails; there is no catch-all site.

Run Caddy `adapt`/`validate` with the same environment file before activation. Verify IP-SAN, publicly trusted chain and required ports. A local certificate or `curl -k` is not evidence. IP certificates are short-lived: assign daily expiry/renewal checks to the owner. Keep Caddy's persistent certificate state outside release directories. Never expose Rust's app port directly.

Caddy overwrites `X-Real-IP` with the real connection address; Rust trusts exactly `127.0.0.1`. Reverify identity before adding another proxy/CDN. Client-supplied `X-Real-IP`/`X-Forwarded-For` must not control counters.

Public allowlist: demo, technical explanation, static assets/saved reports, sources, session creation/read, question start and the visitor's own run. Reading uses GET/HEAD; POST is limited to `/api/session` and `/api/runs`; other routes fail before Rust. Local evaluation workers, replay, judgments, criteria, diagnostics, test questions and report export stay private. Public results must be read-only; do not broaden routes to make local start buttons work.

## Temporary account-free HTTPS route

Cloudflare Quick Tunnels is the temporary alternative when firewall/Funnel management is unavailable. Pin `cloudflared` **2026.11.0**, released **12 November 2026**, Linux-amd64 SHA-256 `51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd`, installed root-owned at `/opt/coa-demo/tools/cloudflared-2026.11.0`. It needs no Cloudflare account, domain purchase or API key.

The route has no SLA, permits at most 200 concurrent HTTP requests and supports no SSE. The demo polls short JSON requests. Its random `trycloudflare.com` URL changes on tunnel-process restart. It is not permanent hosting. App/Caddy restart must not restart the independent tunnel unit; after a tunnel restart, verify the new URL and update shared links.

Use a separate nologin `coa-tunnel` user with `/var/lib/coa-tunnel` (`0700`). Install packaged `config/coa-demo-tunnel.service` root-owned and verify with `systemd-analyze verify`. It opens only an outbound HTTP/2 tunnel to loopback Caddy; metrics bind `127.0.0.1:20242`. It has no capabilities, provider-key environment or access to `/var/lib/coa-demo`. Verify neither `caddy` nor `coa-tunnel` can read the key.

Begin with maintenance `config/Caddyfile.quick-tunnel`: loopback 9899, automatic TLS/admin API disabled, no app proxy, all routes return 503/no-store. Cloudflare supplies public HTTPS. From outside the server verify trusted TLS without `-k`, maintenance text and 503 for `/` and `POST /api/runs`, with the provider ledger unchanged. `config/Caddyfile.quick-tunnel.app` is the separate app configuration, not maintenance mode.

The app variant keeps the public allowlist and rejects worker/admin routes. It overwrites `X-Real-IP` from edge-supplied `CF-Connecting-IP`, only via its owned local tunnel. With an isolated fake backend, prove spoofed public `CF-Connecting-IP`, `X-Real-IP` and `X-Forwarded-For` do not become visitor identity. Without evidence, trust no forwarded address and use a conservative shared counter. Public results must remain read-only.

Cloudflare terminates TLS and processes traffic. Public UI must identify both Cloudflare and OpenAI and prohibit personal data. Keep maintenance mode until privacy, budget, UI and release conditions are approved.

Before changes, privately record `tailscale serve status --json` and PID/start identities of existing private services; compare afterwards without publishing those details. Do not run `tailscale serve reset`, enable Funnel on an existing private port or change broad policies. Stop the tunnel with `systemctl stop coa-demo-tunnel.service`, without a quota reset or coupled app stop. Retain the original IP-route configuration for a separately reviewed permanent route.

## Verify and release the exact version

Require independent review of the built release and actual public route before sharing a new link:

1. Trusted HTTPS is reachable outside Tailscale; HTTP redirects appropriately. Commit/assets match the approved package.
2. Sources, language choice, mobile flow, single expanded activity and saved reports work. The question area identifies an independent fictional prototype and external processing, prohibiting personal data.
3. One explicitly approved bounded fictional question works with real evidence, within the same spending budget. Old smoke tests are not billing evidence.
4. Visitors have separate sessions. Check proxy identity, 429/`Retry-After`, full capacity and denied routes without unlimited model calls.
5. Restart preserves cap/usage; parallel work cannot overspend reservations. Stop blocks new attempts. A local timeout does not prove cancellation of accepted provider work.

Without evidence, local policy enforcement, approved key access and release approval, keep the app unpublished. Packaging/configuration review is not a substitute for an uncompleted separately requested dynamic security audit.

## Stop date and rollback

Optional execution traces are operator-only. Read JSON through `traces list` and `traces export` over existing SSH access as the database-owning application user; the dashboard is optional. Keep the trace directory private to that user and exclude the dashboard port and its `/api/threads` routes from public Caddy/tunnel configuration. See [private trace inspection](traces.md) for commands. Trace setup or local preview does not authorize deployment or a new model allowance.

Assign an owner and stop date at release. Stop with `systemctl stop coa-demo.service` on unexpected spending, abuse, misleading source/privacy presentation or unknown budget state. Verify new provider traffic cannot start and preserve the ledger. Keep unrelated SSH/Tailscale/services running.

Use maintenance 503 while unavailable. Rollback only to an independently reviewed **policy-2 release with exact input counting**: stop Rust, verify checksums, switch `current`, restart with the same v2 budget. An old attempt-only release is insufficient for the new issuance; leave service stopped. Preserve unrelated sites if Caddy's host-wide configuration has since changed.

If the rollback release prunes traces, unset `COA_TRACE_DB` for that release before restarting. Keep the private trace database and its sidecar files intact for inspection and for the next release that retains traces until owner-approved deletion.

## Dated references

- [Caddy 2.11.9](https://github.com/caddyserver/caddy/releases/tag/v2.11.9), published **5 November 2026**.
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), updated **30 September 2026**.
- [cloudflared 2026.11.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0), published **12 November 2026**, including the pinned checksum.
- [Let's Encrypt IP/six-day certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), published **15 January 2026**, updated **11 March 2026**.
- [Let's Encrypt profiles](https://letsencrypt.org/docs/profiles/), updated **4 October 2026**: `shortlived` supports IP addresses and 160-hour certificates.
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), updated **6 March 2026** ([source commit](https://github.com/caddyserver/website/commit/9a26b56e3b36ea4dea362b504ad19101fdf11461)).
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), updated **8 November 2026** ([source commit](https://github.com/caddyserver/website/commit/e71548f6f16ebbae678062968158ca788069ef06)).

These recorded references support the mechanism, not current URL validity, certificate issuance, account state or capacity. Recheck those at deployment time.
