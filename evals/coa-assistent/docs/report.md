# Local evaluation report

Start with the [visual framework explanation](framework.html): one question, predeclared evidence and what a score means.

The report helps readers inspect retrieval without technical logs. Its existing interface is Dutch, with compact comparisons, status colors and expandable detail. This English documentation does not translate functional report templates or preserved source text.

`experiment report --input resultaten.jsonl --output rapport.html` creates one standalone HTML file. Multiple inputs can be comma-separated. It uses no model or network. Open the file directly in a browser; if serving a preview, expose only the HTML directory and keep ledgers/logs elsewhere.

`evals/coa-assistent/fixtures/report-example.jsonl` contains six handmade renderer checks, not measured RAG results. Its banner stays visible. Generation/judge statuses and provenance remain distinct; example grades cannot count as real quality evidence. Human calibration is deferred.

Evidence coverage, provisional AI judgment and efficiency are separate. `1 van 2 (0,50)` means support for one of two required facts. The answer judge checks whether the facts are used correctly and cannot repair a hard failure. Undecided criteria retain both the judged denominator and undecided count.

Examples, development, pilot and predeclared comparison questions are not merged into one benchmark. Only saved runs count; a missing artifact is not a zero measurement. Timeouts, cancellations and skipped runs remain visible. Direct context performs no searches, so zero searches and “context supplied in advance” are expected.

The renderer validates dataset/question/criterion hashes and recomputes metrics. Empty, invalid or duplicate artifacts cause an error without replacing an existing report. Text is escaped; HTML has no external fonts, CDN or fetch code. Filters work when opened directly from disk. A readable HTML report is not a signed attestation.
