# Six predeclared comparison questions

`heldout-questions.json` and `heldout-expectations.json` share the twelve-case pilot schema. They cover supplies across three activities, an indoor Tuesday activity, undocumented French-language help, a distance limit, two appointments and missing bad-weather policy. They are new compositions of known source facts, not a new domain or a guarantee against all overlap.

The six intent families sit outside the pilot families. This small purposive set supports an exploratory four-arm comparison, not an estimate of general reliability. A schedule does not guarantee a place; an undocumented language or adaptation is not impossible.

T03 combines a French-guidance guarantee across two activities, although language help/unknown languages were already pilot facts. T05 combines two appointments whose individual time/address facts were known. The holdout concerns these predeclared compositions, not unseen facts. T02's bicycle S1 is relevant workshop context but cannot establish Tuesday plus indoors; S2 and S3 remain jointly required.

`heldout-freeze.json` binds exact questions and criteria through compact schema-JSON hashes before the first live run. The generator receives only the question and actual context; expectations remain separate. Independent label review is required before live use. Human calibration is deferred and is not claimed.

After first execution, do not tune prompts/retrieval on these six questions and claim another unseen comparison. Investigating a failure is allowed; a tuned run is development. A genuine label error receives an explained new version while preserving the original artifact.
