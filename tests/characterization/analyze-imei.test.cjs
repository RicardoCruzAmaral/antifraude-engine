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

test("events públicos expõem somente presença categórica do IMEI", async () => {
  const rawImei = "000000000000000";
  const providerResult = {
    ...imeiResult("IMEI_OK"),
    summary: {
      brand: "SAMSUNG",
      model_name: "Synthetic Phone",
      imei_checked: rawImei,
    },
  };
  const result = await invokeAnalyze({
    input: { ...SYNTHETIC_INPUT, imeiCode: rawImei },
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    imeiResult: providerResult,
  });

  const inputEvent = result.internalBody.events.find(
    (event) => event.step === "input_summary_built"
  );
  assert.deepEqual(inputEvent.meta, { hasImeiCode: true });
  assert.equal(JSON.stringify(result.body).includes(rawImei), false);
  assert.equal(Object.hasOwn(result.internalBody.imei.summary, "imei_checked"), false);
  assert.equal(result.internalBody.imei.summary.model_name, "Synthetic Phone");
  assert.equal(result.internalBody.imei.reason, "IMEI_OK");
  assert.equal(result.body.decision, "APPROVE");
  assert.equal(result.calls.imei.length, 1);
});

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
    assert.equal(result.internalBody.imei.reason, reason);
    assert.deepEqual(
      result.internalBody.events.map((event) => event.step),
      [
        "request_received",
        "fingerprint_snapshot",
        "input_summary_built",
        "validate_input",
        "supabase_missing_continue",
        "cache_get_skipped_no_supabase",
        "enrichment_start",
        "enrichment_done",
        "enrichment_raw_skipped_no_supabase",
        "hard_block_check",
        "score_computed",
        "imei_check_start",
        "imei_check_done",
        "decision_profiled",
        "decision_made",
        "cache_set_skipped_no_supabase",
        "response_sent",
      ]
    );
    assert.deepEqual(projectDecision(result.internalBody), {
      decision: "APPROVE",
      score: hasPenalty ? 5 : 0,
      reasons: expectedBreakdown.map((item) => item.rule),
      scoreBreakdown: expectedBreakdown,
      profile: "A",
      hardBlock: { isHardBlock: false, reasons: [] },
    });

    const scoreComputedEvent = result.internalBody.events.find(
      (event) => event.step === "score_computed"
    );
    assert.equal(scoreComputedEvent.meta.score, 0);
    assert.deepEqual(scoreComputedEvent.meta.breakdown, expectedBreakdown);
  });
}

test("SCORE_IMEI_PROBLEM continua configurando a penalidade do handler", async () => {
  const result = await invokeAnalyze({
    input: { ...SYNTHETIC_INPUT, imeiCode: "000000000000000" },
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    imeiResult: imeiResult("IMEI_INVALID"),
    env: { SCORE_IMEI_PROBLEM: "7" },
  });

  assert.deepEqual(projectDecision(result.internalBody), {
    decision: "APPROVE",
    score: 7,
    reasons: ["RISCO_BAIXISSIMO", "PROB_ALTISSIMA", "IMEI_INVALID"],
    scoreBreakdown: [
      ...expectedBaseBreakdown,
      { rule: "IMEI_INVALID", points: 7 },
    ],
    profile: "A",
    hardBlock: { isHardBlock: false, reasons: [] },
  });
});

test("hard block textual pula a chamada IMEI", async () => {
  const result = await invokeAnalyze({
    input: { ...SYNTHETIC_INPUT, imeiCode: "000000000000000" },
    enrichmentResult: enrichmentResult(
      enrichmentSummary({ motivos: ["NOME DIVERGENTE"] })
    ),
    imeiResult: imeiResult("IMEI_OK"),
  });

  assert.equal(result.calls.imei.length, 0);
  assert.deepEqual(
    result.internalBody.events.map((event) => event.step),
    [
      "request_received",
      "fingerprint_snapshot",
      "input_summary_built",
      "validate_input",
      "supabase_missing_continue",
      "cache_get_skipped_no_supabase",
      "enrichment_start",
      "enrichment_done",
      "enrichment_raw_skipped_no_supabase",
      "hard_block_check",
      "decision_made",
      "cache_set_skipped_no_supabase",
      "response_sent",
    ]
  );
  assert.deepEqual(projectDecision(result.internalBody), {
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

  assert.equal(result.internalBody.fingerprint.os, "Android");
  assert.equal(result.internalBody.fingerprint.isMobile, false);
  assert.equal(result.body.score, 0);
  assert.equal(result.body.decision, "APPROVE");
  assert.equal(result.calls.imei.length, 0);
  assert.deepEqual(
    result.internalBody.events.map((event) => event.step),
    [
      "request_received",
      "fingerprint_snapshot",
      "input_summary_built",
      "validate_input",
      "supabase_missing_continue",
      "cache_get_skipped_no_supabase",
      "enrichment_start",
      "enrichment_done",
      "enrichment_raw_skipped_no_supabase",
      "hard_block_check",
      "score_computed",
      "imei_check_skipped",
      "decision_profiled",
      "decision_made",
      "cache_set_skipped_no_supabase",
      "response_sent",
    ]
  );

  const scoreComputedEvent = result.internalBody.events.find(
    (event) => event.step === "score_computed"
  );
  assert.deepEqual(scoreComputedEvent.meta.flags, {
    nonMobile: true,
    emailDivergente: false,
    telefoneDivergente: false,
    cepDivergente: false,
    riscoCredito: "BAIXISSIMO",
    probabilidadePagamento: "ALTISSIMA",
    quantidadeProcessos: 0,
  });
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

require("./provider-adapters.cases.cjs");
