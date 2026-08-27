const test = require("node:test");
const assert = require("node:assert/strict");

const { invokeAnalyze, projectDecision } = require("../helpers/analyze-characterization-harness.cjs");
const {
  SYNTHETIC_INPUT,
  enrichmentResult,
  enrichmentSummary,
  imeiResult,
} = require("../helpers/synthetic-fixtures.cjs");

const expectedBaseBreakdown = [
  { rule: "RISCO_BAIXISSIMO", points: 0 },
  { rule: "PROB_ALTISSIMA", points: 0 },
];

for (const reason of [
  "IMEI_OK",
  "IMEI_INVALID",
  "IMEI_FAIL",
  "IMEI_BRAND_MISMATCH",
]) {
  test(`comportamento atual do handler para ${reason}`, async () => {
    const result = await invokeAnalyze({
      input: { ...SYNTHETIC_INPUT, imeiCode: "000000000000000" },
      enrichmentResult: enrichmentResult(enrichmentSummary()),
      imeiResult: imeiResult(reason),
    });

    const hasPenalty = reason !== "IMEI_OK";
    const expectedBreakdown = hasPenalty
      ? [...expectedBaseBreakdown, { rule: reason, points: 5 }]
      : expectedBaseBreakdown;

    assert.equal(result.statusCode, 200);
    assert.equal(result.networkCalls, 0);
    assert.equal(result.calls.supabase.length, 0);
    assert.equal(result.calls.enrichment.length, 1);
    assert.equal(result.calls.imei.length, 1);
    assert.equal(result.body.imei.reason, reason);
    assert.deepEqual(projectDecision(result.body), {
      decision: "APPROVE",
      score: hasPenalty ? 5 : 0,
      reasons: expectedBreakdown.map((item) => item.rule),
      scoreBreakdown: expectedBreakdown,
      profile: "A",
      hardBlock: { isHardBlock: false, reasons: [] },
    });
  });
}

test("hard block textual pula a chamada IMEI", async () => {
  const result = await invokeAnalyze({
    input: { ...SYNTHETIC_INPUT, imeiCode: "000000000000000" },
    enrichmentResult: enrichmentResult(
      enrichmentSummary({ motivos: ["NOME DIVERGENTE"] })
    ),
    imeiResult: imeiResult("IMEI_OK"),
  });

  assert.equal(result.calls.imei.length, 0);
  assert.deepEqual(projectDecision(result.body), {
    decision: "DECLINE",
    score: null,
    reasons: ["NOME DIVERGENTE"],
    scoreBreakdown: [],
    profile: null,
    hardBlock: { isHardBlock: true, reasons: ["NOME DIVERGENTE"] },
  });
});

test("fingerprint sintético é devolvido, mas não altera score ou decisão", async () => {
  const result = await invokeAnalyze({
    input: {
      ...SYNTHETIC_INPUT,
      modelo_declarado: "Apple iPhone TEST",
      device: {
        ...SYNTHETIC_INPUT.device,
        os: "Android",
        incognito: true,
        isMobile: false,
      },
    },
    enrichmentResult: enrichmentResult(enrichmentSummary()),
  });

  assert.equal(result.body.fingerprint.os, "Android");
  assert.equal(result.body.fingerprint.isMobile, false);
  assert.equal(result.body.score, 0);
  assert.equal(result.body.decision, "APPROVE");
});

test("decisão DECLINADO do enrichment não é usada pela decisão final", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: enrichmentResult(
      enrichmentSummary({ providerDecision: "DECLINADO" })
    ),
  });

  assert.equal(result.body.score, 0);
  assert.equal(result.body.decision, "APPROVE");
});
