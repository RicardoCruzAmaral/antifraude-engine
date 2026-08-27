# Characterization tests

These tests freeze the behavior currently executed by `api/analyze.ts`. They do
not define the desired fraud policy.

The harness transpiles the current TypeScript source in memory and exposes its
private rule functions only inside the test process. Production source files are
not rewritten or imported with extra exports.

All provider and Supabase modules are replaced with controlled stubs. Global
`fetch` throws if the handler unexpectedly attempts a network request.

The golden master contains only explicitly synthetic data. Its expected values
must not be regenerated automatically after a failure. A mismatch must be
reviewed as a possible behavior change.
