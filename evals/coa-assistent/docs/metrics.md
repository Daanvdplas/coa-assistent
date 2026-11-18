# Metric definitions

A deterministic calculation can produce a float. `0.5` can mean one of two evidence goals; it is not the probability that an answer is correct.

`first_hop_fact_coverage` measures source-supported fact criteria covered after the first search attempt. `all_hop_fact_coverage` uses their union across searches. OR joins alternative groups; AND joins sections within a group. Explicit unknowns can have supporting source sections. No positive evidence target means N/A. Existing expected evidence with no hits means zero coverage.

Sections are deduplicated by document plus section ID. Changed document/date/title/heading/text is invalid evidence. `precision` divides relevant valid sections by all unique returned sections; `section_recall` divides relevant found sections by all labelled relevant sections. Useful exclusion evidence counts, including other activities' schedules for a complete Tuesday list. Both metrics need complete relevance labels; fact coverage does not.

Reciprocal rank uses the original position of the first relevant passage in the first attempt. No relevant hit scores zero when relevant passages exist. A failed first MCP attempt receives no credit from a later success. With zero returned sections, precision is undefined; recall is zero if relevant sections exist.

The full-context arm performs no retrieval and gets N/A for retrieval metrics. `offered_fact_coverage` separately measures goals supported by supplied context, not search ability or answer quality. Observed search results remain measurable in a partly failed run; without an observed attempt, retrieval is undefined and the failed status remains visible.

Hard checks are prerequisites, not an answer-quality verdict: completion, complete live trace, valid artifact with fixed source hashes/limits, exact sources and agreement between real tool results and offered context. Fixtures test the measuring instrument and never pass live-execution conditions. A high judge score cannot override a hard failure. Valid citations alone do not establish logical entailment.

Search actions, MCP calls, elapsed time and available token usage remain separate. Local preselection is not an MCP call. Incomplete agent traces leave actual call count unknown; recorded calls remain individually inspectable. One search is not a universal pass criterion. Missing usage is unknown, never zero. Time includes per-question preparation, retrieval and generation, excluding shared index construction but including MCP startup within a session; this is not a uniform cold-start benchmark. Every metric records definition, direction, numerator/denominator or value and N/A reason.

Saved JSON reports have strict schemas and consistent counts, not signatures. Recompute metrics from stored source traces to check a modified artifact. `execution_kind: live` alone does not prove provider execution; provenance comes from the actual runner and recorded runtime identity.
