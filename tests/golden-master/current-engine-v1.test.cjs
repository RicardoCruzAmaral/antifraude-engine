const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { invokeAnalyze, projectDecision } = require("../helpers/analyze-characterization-harness.cjs");
const { enrichmentResult, imeiResult } = require("../helpers/synthetic-fixtures.cjs");

const goldenPath = path.resolve(
  __dirname,
  "../fixtures/golden-master/current-engine-v1.json"
);
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

for (const fixture of golden.cases) {
  test(`golden master: ${fixture.id}`, async () => {
    const input = {
      ...golden.syntheticBaseInput,
      ...fixture.inputOverrides,
      device: {
        ...golden.syntheticBaseInput.device,
        ...(fixture.inputOverrides.device ?? {}),
      },
    };

    const result = await invokeAnalyze({
      input,
      enrichmentResult: enrichmentResult(fixture.summary),
      imeiResult: fixture.imeiResult ? imeiResult(fixture.imeiResult) : null,
      env: golden.environment.overrides,
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.networkCalls, 0);
    assert.equal(result.calls.supabase.length, 0);
    assert.equal(result.calls.enrichment.length, 1);
    assert.equal(
      result.calls.imei.length,
      fixture.inputOverrides.imeiCode && !fixture.expected.hardBlock.isHardBlock ? 1 : 0
    );
    assert.deepEqual(projectDecision(result.internalBody), fixture.expected);
  });
}
