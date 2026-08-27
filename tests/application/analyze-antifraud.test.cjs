const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadAnalyzeUseCaseForCharacterization,
  withMutedConsoleAsync,
} = require("../helpers/analyze-characterization-harness.cjs");
const {
  SYNTHETIC_INPUT,
  enrichmentResult,
  enrichmentSummary,
  imeiResult,
} = require("../helpers/synthetic-fixtures.cjs");

const defaultConfig = {
  supabaseMissingPolicy: "continue",
  enrichmentTimeoutMs: 20,
  enrichmentMode: "mock",
  enrichmentFailDecision: "DECLINE",
  imeiTimeoutMs: 20000,
  imeiPenalty: 5,
  cacheTtlDaysApprove: 30,
  cacheTtlDaysDecline: 30,
  cacheTtlSecondsTechFail: 300,
};

function setup(options = {}) {
  const calls = [];
  const persist = options.persistence !== false;
  const dependencies = {
    enrichmentProvider: {
      async enrich(input) {
        calls.push("enrichment");
        if (options.enrichmentThrows) throw options.enrichmentThrows;
        if (options.enrichmentPromise) return options.enrichmentPromise;
        return options.enrichment ?? enrichmentResult(enrichmentSummary());
      },
    },
    imeiProvider: {
      async check(input) {
        calls.push("imei");
        return options.imei ?? imeiResult("IMEI_OK");
      },
    },
    decisionCache: persist ? {
      async get(cpf) {
        calls.push("cache.get");
        if (options.cacheReadThrows) throw options.cacheReadThrows;
        return options.cacheHit ?? null;
      },
      async set(row) {
        calls.push("cache.set");
        if (options.cacheWriteThrows) throw options.cacheWriteThrows;
        return "2099-01-01T00:00:00.000Z";
      },
    } : null,
    decisionAuditRepository: persist ? {
      async saveDecision(row) {
        calls.push("audit");
        if (options.auditThrows) throw options.auditThrows;
      },
    } : null,
    providerRawRepository: persist ? {
      async saveEnrichment(row) {
        calls.push("raw.enrichment");
        if (options.rawThrows) throw options.rawThrows;
      },
      async saveImei(row) {
        calls.push("raw.imei");
        if (options.rawThrows) throw options.rawThrows;
      },
    } : null,
  };
  const { AnalyzeAntifraudUseCase } = loadAnalyzeUseCaseForCharacterization();
  const useCase = new AnalyzeAntifraudUseCase(dependencies);
  return {
    calls,
    execute: (body = SYNTHETIC_INPUT, config = {}) => withMutedConsoleAsync(() => useCase.execute({
      body,
      traceId: "trace-test",
      startedAtMs: Date.now(),
      config: { ...defaultConfig, ...config },
    })),
  };
}

test("use case executa fluxo APPROVE normal", async () => {
  const fixture = setup();
  const result = await fixture.execute();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.source, "engine");
  assert.equal(result.body.decision, "APPROVE");
});

test("use case executa DECLINE por perfil C", async () => {
  const fixture = setup({ enrichment: enrichmentResult(enrichmentSummary({
    riscoCredito: "ALTO",
    probabilidadePagamento: "BAIXISSIMA",
    quantidadeProcessos: 6,
  })) });
  const result = await fixture.execute();
  assert.equal(result.body.decision, "DECLINE");
  assert.equal(result.body.events.find((event) => event.step === "decision_profiled").meta.profile, "C");
});

test("use case executa hard block", async () => {
  const fixture = setup({ enrichment: enrichmentResult(enrichmentSummary({ motivos: ["NOME DIVERGENTE"] })) });
  const result = await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "0" });
  assert.equal(result.body.decision, "DECLINE");
  assert.deepEqual(result.body.reasons, ["NOME DIVERGENTE"]);
  assert.ok(!fixture.calls.includes("imei"));
});

test("use case retorna cache hit sem campos exclusivos do engine", async () => {
  const fixture = setup({ cacheHit: {
    cpf: "00000000000", decision: "APPROVE", score: 2, reasons: ["CACHE"],
    ruleVersion: "cached-v1", expiresAt: "2099-01-01T00:00:00.000Z",
  } });
  const result = await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "0" });
  assert.equal(result.body.source, "cache");
  assert.equal(Object.hasOwn(result.body, "scoreBreakdown"), false);
  assert.equal(Object.hasOwn(result.body, "imei"), false);
  assert.ok(!fixture.calls.includes("enrichment"));
});

for (const label of ["cache miss", "entrada expirada"]) {
  test(`use case trata ${label} como caminho engine`, async () => {
    const fixture = setup({ cacheHit: null });
    const result = await fixture.execute();
    assert.equal(result.body.source, "engine");
    assert.ok(fixture.calls.includes("enrichment"));
  });
}

test("use case trata enrichment failure", async () => {
  const fixture = setup({ enrichment: { ok: false, mode: "mock", provider: "mock", error: { msg: "fail" } } });
  const result = await fixture.execute();
  assert.equal(result.body.decision, "DECLINE");
  assert.deepEqual(result.body.reasons, ["ENRICHMENT_FAILED"]);
});

test("use case trata enrichment timeout", async () => {
  const fixture = setup({ enrichmentPromise: new Promise(() => {}) });
  const result = await fixture.execute(SYNTHETIC_INPUT, { enrichmentTimeoutMs: 1 });
  assert.deepEqual(result.body.reasons, ["ENRICHMENT_TIMEOUT"]);
});

for (const reason of ["IMEI_OK", "IMEI_INVALID", "IMEI_FAIL", "IMEI_BRAND_MISMATCH"]) {
  test(`use case preserva ${reason}`, async () => {
    const fixture = setup({ imei: imeiResult(reason) });
    const result = await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "000000000000000" });
    assert.equal(result.body.imei.reason, reason);
    assert.equal(result.body.score, reason === "IMEI_OK" ? 0 : 5);
  });
}

test("hard block pula IMEI no use case", async () => {
  const fixture = setup({ enrichment: enrichmentResult(enrichmentSummary({ motivos: ["NOME DIVERGENTE"] })) });
  await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "000000000000000" });
  assert.equal(fixture.calls.includes("imei"), false);
});

for (const [label, option] of [
  ["cache read", { cacheReadThrows: new Error("read") }],
  ["cache write", { cacheWriteThrows: new Error("write") }],
  ["audit", { auditThrows: new Error("audit") }],
  ["raw persistence", { rawThrows: new Error("raw") }],
]) {
  test(`falha de ${label} permanece best-effort`, async () => {
    const fixture = setup(option);
    const result = await fixture.execute();
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.decision, "APPROVE");
  });
}

test("persistência ausente com continue executa engine", async () => {
  const fixture = setup({ persistence: false });
  const result = await fixture.execute();
  assert.equal(result.statusCode, 200);
  assert.ok(result.body.events.some((event) => event.step === "supabase_missing_continue"));
});

test("persistência ausente com fail retorna resultado 500", async () => {
  const fixture = setup({ persistence: false });
  const result = await fixture.execute(SYNTHETIC_INPUT, { supabaseMissingPolicy: "fail" });
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.error, "FUNCTION_INVOCATION_FAILED");
  assert.deepEqual(fixture.calls, []);
});

test("use case preserva ordem das chamadas importantes", async () => {
  const fixture = setup();
  await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "000000000000000" });
  assert.deepEqual(fixture.calls, [
    "cache.get", "enrichment", "raw.enrichment", "imei", "raw.imei", "cache.set", "audit",
  ]);
});
