const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadAnalyzeUseCaseForCharacterization,
  loadCacheV2FoundationForCharacterization,
  withMutedConsoleAsync,
} = require("../helpers/analyze-characterization-harness.cjs");
const {
  SYNTHETIC_INPUT,
  enrichmentResult,
  enrichmentSummary,
} = require("../helpers/synthetic-fixtures.cjs");

const { AnalyzeAntifraudUseCase } = loadAnalyzeUseCaseForCharacterization();
const foundation = loadCacheV2FoundationForCharacterization();
const tokenService = foundation.hmac.createHmacLookupTokenService("synthetic-imei-read-secret");
const validImei = "490154203237518";

const config = {
  supabaseMissingPolicy: "continue", enrichmentTimeoutMs: 20, enrichmentMode: "mock",
  enrichmentFailDecision: "DECLINE", imeiTimeoutMs: 20000, imeiPenalty: 5,
  cacheTtlDaysApprove: 30, cacheTtlDaysDecline: 30, cacheTtlSecondsTechFail: 300,
  decisionCacheV1ReadEnabled: false,
};

function context(input) {
  const declared = String(input.modeloDeclarado || "").toUpperCase();
  return {
    normalizedImei: String(input.imeiCode || "").replace(/\D/g, ""),
    brandExpected: declared.includes("SAMSUNG") || declared.includes("GALAXY") ? "SAMSUNG"
      : declared.includes("APPLE") || declared.includes("IPHONE") ? "APPLE" : "UNKNOWN",
    serviceId: 76,
    service: "76",
  };
}

function factualEvidence(overrides = {}) {
  return {
    lookupToken: tokenService.tokenizeImei(validImei), provider: "imei_info", service: "76",
    normalizedEvidence: {
      reason: "IMEI_OK", httpStatus: 200, brandReturned: "APPLE", serviceId: 76,
      summary: { brand: "APPLE", model_name: "iPhone Synthetic" },
    },
    fetchedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    providerContractVersion: "imei-info-v1", normalizerVersion: "imei-normalizer-v2",
    cacheSchemaVersion: "cache-v2-schema-v1", completeness: "COMPLETE",
    rawReference: "raw-imei-1", ...overrides,
  };
}

function providerResult(brandExpected = "SAMSUNG") {
  return {
    ok: false, provider: "imei_info", ms: 7, httpStatus: 200,
    reason: "IMEI_BRAND_MISMATCH", brandExpected, brandReturned: "APPLE", serviceId: 76,
    summary: { brand: "APPLE", model_name: "iPhone Synthetic" }, raw: { synthetic: true },
  };
}

function setup(options = {}) {
  const calls = { read: [], put: [], provider: 0, raw: 0, audit: [], telemetry: [] };
  const read = options.read === false ? undefined : {
    imeiEvidenceCache: options.cacheUnavailable ? null : {
      async get(key) {
        calls.read.push(key);
        if (options.cacheThrows) throw options.cacheThrows;
        return options.lookup ?? { state: "HIT", value: factualEvidence(), ageMs: 1000 };
      },
      async put(value) { calls.put.push(value); },
    },
    lookupTokenService: options.lookupTokenService === undefined ? tokenService : options.lookupTokenService,
    telemetry: { record(event) { calls.telemetry.push(event); } },
    provider: "imei_info", providerContractVersion: "imei-info-v1",
    normalizerVersion: "imei-normalizer-v2", cacheSchemaVersion: "cache-v2-schema-v1",
    resolveContext: options.resolveContext ?? context,
  };
  const useCase = new AnalyzeAntifraudUseCase({
    enrichmentProvider: { async enrich() { return enrichmentResult(options.enrichmentSummary ?? enrichmentSummary()); } },
    imeiProvider: { async check(input) { calls.provider += 1; return options.providerResult ?? providerResult(context(input).brandExpected); } },
    decisionCache: { async get() { return null; }, async set() { return "2099-01-01T00:00:00.000Z"; } },
    decisionAuditRepository: { async saveDecision(row) { calls.audit.push(row); } },
    providerRawRepository: { async saveEnrichment() {}, async saveImei() { calls.raw += 1; } },
    cacheV2ImeiRead: read,
  });
  return {
    calls,
    execute(input = { ...SYNTHETIC_INPUT, imeiCode: validImei, modelo_declarado: "Samsung Galaxy" }) {
      return withMutedConsoleAsync(() => useCase.execute({ body: input, traceId: "imei-read-trace", startedAtMs: Date.now(), config }));
    },
  };
}

function projection(result) {
  return {
    score: result.body.score, reasons: result.body.reasons, decision: result.body.decision,
    profile: result.body.events.find((event) => event.step === "decision_profiled")?.meta.profile ?? null,
  };
}

test("flag off não lê cache IMEI e preserva provider/decisão", async () => {
  const fixture = setup({ read: false });
  const result = await fixture.execute();
  assert.equal(fixture.calls.read.length, 0);
  assert.equal(fixture.calls.provider, 1);
  assert.equal(result.body.reasons.includes("IMEI_BRAND_MISMATCH"), true);
});

test("HIT evita provider e preserva resultado equivalente", async () => {
  const hit = setup();
  const real = setup({ read: false });
  const [cached, provided] = await Promise.all([hit.execute(), real.execute()]);
  assert.equal(hit.calls.provider, 0);
  assert.equal(real.calls.provider, 1);
  assert.deepEqual(projection(cached), projection(provided));
});

test("identidade usa IMEI, provider, service e versões; ignora CPF/proposta/contexto", async () => {
  const first = setup();
  const second = setup();
  await first.execute();
  await second.execute({ ...SYNTHETIC_INPUT, cpf: "11111111111", proposalId: "OTHER", valor_celular: 9999, email: "other@example.invalid", imeiCode: validImei, modelo_declarado: "Samsung Galaxy" });
  assert.deepEqual(first.calls.read[0], second.calls.read[0]);
  assert.deepEqual(Object.keys(first.calls.read[0]).sort(), ["cacheSchemaVersion", "lookupToken", "normalizerVersion", "provider", "providerContractVersion", "service"].sort());
});

test("IMEI diferente gera lookup token diferente", async () => {
  const first = setup({ lookup: { state: "MISS" } });
  const second = setup({ lookup: { state: "MISS" } });
  await first.execute();
  await second.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237526", modelo_declarado: "Samsung Galaxy" });
  assert.notEqual(first.calls.read[0].lookupToken, second.calls.read[0].lookupToken);
});

for (const [state, lookup] of [
  ["MISS", { state: "MISS" }],
  ["EXPIRED", { state: "EXPIRED", expiredAt: "2020-01-01T00:00:00.000Z" }],
  ["INCOMPATIBLE", { state: "INCOMPATIBLE", reason: "NORMALIZER_VERSION" }],
  ["BACKEND_ERROR", { state: "BACKEND_ERROR", errorCode: "DB_DOWN" }],
]) {
  test(`${state} chama provider IMEI exatamente uma vez`, async () => {
    const fixture = setup({ lookup });
    const result = await fixture.execute();
    assert.equal(fixture.calls.provider, 1);
    assert.equal(result.statusCode, 200);
  });
}

test("HIT defensivo vencido chama provider uma vez", async () => {
  const fixture = setup({ lookup: { state: "HIT", value: factualEvidence({ expiresAt: "2020-01-01T00:00:00.000Z" }), ageMs: 1 } });
  await fixture.execute();
  assert.equal(fixture.calls.provider, 1);
});

test("erro HMAC faz fallback para provider", async () => {
  const fixture = setup({ lookupTokenService: { tokenizeImei() { throw new Error("hmac"); } } });
  await fixture.execute();
  assert.equal(fixture.calls.provider, 1);
});

test("adapter indisponível faz bypass para provider", async () => {
  const fixture = setup({ cacheUnavailable: true });
  const result = await fixture.execute();
  assert.equal(fixture.calls.provider, 1);
  assert.equal(result.statusCode, 200);
});

test("hard block não consulta cache nem provider IMEI", async () => {
  const fixture = setup({ enrichmentSummary: enrichmentSummary({ motivos: ["NOME DIVERGENTE"] }) });
  await fixture.execute();
  assert.equal(fixture.calls.read.length, 0);
  assert.equal(fixture.calls.provider, 0);
});

test("ausência de IMEI não consulta cache nem provider", async () => {
  const fixture = setup();
  await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: null });
  assert.equal(fixture.calls.read.length, 0);
  assert.equal(fixture.calls.provider, 0);
});

test("HIT não grava raw, não renova TTL e mantém proveniência somente na auditoria", async () => {
  const fixture = setup();
  const result = await fixture.execute();
  assert.equal(fixture.calls.raw, 0);
  assert.equal(fixture.calls.put.length, 0);
  assert.equal(result.body.events.some((event) => event.step === "cache_v2_imei_read"), false);
  const provenance = fixture.calls.audit[0].events.find((event) => event.step === "cache_v2_imei_read");
  assert.equal(provenance.meta.state, "HIT");
  assert.equal(provenance.meta.rawReference, "raw-imei-1");
  assert.equal(provenance.meta.service, "76");
});

test("mismatch é reaplicado com modelo declarado atual e não vem congelado da evidência", async () => {
  const samsung = setup();
  const apple = setup();
  const fromSamsung = await samsung.execute({ ...SYNTHETIC_INPUT, imeiCode: validImei, modelo_declarado: "Samsung Galaxy" });
  const fromApple = await apple.execute({ ...SYNTHETIC_INPUT, imeiCode: validImei, modelo_declarado: "Apple iPhone" });
  assert.equal(fromSamsung.body.reasons.includes("IMEI_BRAND_MISMATCH"), true);
  assert.equal(fromApple.body.reasons.includes("IMEI_BRAND_MISMATCH"), false);
  assert.equal(samsung.calls.provider, 0);
  assert.equal(apple.calls.provider, 0);
});

test("evidência contextual antiga com mismatch é incompatível e não é reutilizada", async () => {
  const fixture = setup({ lookup: { state: "HIT", value: factualEvidence({ normalizedEvidence: { reason: "IMEI_BRAND_MISMATCH", brandExpected: "SAMSUNG", brandReturned: "APPLE" } }), ageMs: 1 } });
  await fixture.execute();
  assert.equal(fixture.calls.provider, 1);
});
