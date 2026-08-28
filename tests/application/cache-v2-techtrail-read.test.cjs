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
  imeiResult,
} = require("../helpers/synthetic-fixtures.cjs");

const { AnalyzeAntifraudUseCase } = loadAnalyzeUseCaseForCharacterization();
const foundation = loadCacheV2FoundationForCharacterization();
const tokenService = foundation.hmac.createHmacLookupTokenService("synthetic-read-secret");

const config = {
  supabaseMissingPolicy: "continue",
  enrichmentTimeoutMs: 20,
  enrichmentMode: "mock",
  enrichmentFailDecision: "DECLINE",
  imeiTimeoutMs: 20000,
  imeiPenalty: 5,
  cacheTtlDaysApprove: 30,
  cacheTtlDaysDecline: 30,
  cacheTtlSecondsTechFail: 300,
  decisionCacheV1ReadEnabled: false,
};

function evidence(summary = enrichmentSummary(), overrides = {}) {
  return {
    lookupToken: tokenService.tokenizeCpf(SYNTHETIC_INPUT.cpf),
    provider: "mock",
    normalizedEvidence: summary,
    fetchedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    providerContractVersion: "techtrail-person-v1",
    normalizerVersion: "techtrail-normalizer-v1",
    cacheSchemaVersion: "cache-v2-schema-v1",
    completeness: "COMPLETE",
    rawReference: "raw-techtrail-1",
    ...overrides,
  };
}

function setup(options = {}) {
  const calls = {
    cacheRead: [],
    cachePut: [],
    provider: 0,
    imei: 0,
    enrichmentRaw: 0,
    audit: [],
    telemetry: [],
    decisionCacheGet: 0,
  };
  const read = options.read === false ? undefined : {
    enrichmentEvidenceCache: {
      async get(key) {
        calls.cacheRead.push(key);
        if (options.cacheThrows) throw options.cacheThrows;
        if (options.lookup) return typeof options.lookup === "function" ? options.lookup(key) : options.lookup;
        return { state: "HIT", value: evidence(options.summary), ageMs: 1000 };
      },
      async put(value) { calls.cachePut.push(value); },
    },
    lookupTokenService: options.lookupTokenService === undefined ? tokenService : options.lookupTokenService,
    telemetry: { record(event) { calls.telemetry.push(event); } },
    provider: "mock",
    providerContractVersion: "techtrail-person-v1",
    normalizerVersion: "techtrail-normalizer-v1",
    cacheSchemaVersion: "cache-v2-schema-v1",
  };
  const useCase = new AnalyzeAntifraudUseCase({
    enrichmentProvider: {
      async enrich() {
        calls.provider += 1;
        return options.providerResult ?? enrichmentResult(options.summary ?? enrichmentSummary());
      },
    },
    imeiProvider: {
      async check() {
        calls.imei += 1;
        return options.imeiResult ?? imeiResult("IMEI_OK");
      },
    },
    decisionCache: {
      async get() { calls.decisionCacheGet += 1; return options.decisionCacheHit ?? null; },
      async set() { return "2099-01-01T00:00:00.000Z"; },
    },
    decisionAuditRepository: { async saveDecision(row) { calls.audit.push(row); } },
    providerRawRepository: {
      async saveEnrichment() { calls.enrichmentRaw += 1; },
      async saveImei() {},
    },
    cacheV2TechTrailRead: read,
  });
  return {
    calls,
    execute: (input = SYNTHETIC_INPUT, overrides = {}) => withMutedConsoleAsync(() => useCase.execute({
      body: input,
      traceId: "read-trace",
      startedAtMs: Date.now(),
      config: { ...config, ...overrides },
    })),
  };
}

function projection(result) {
  return {
    decision: result.body.decision,
    score: result.body.score,
    reasons: result.body.reasons,
    profile: result.body.events.find((event) => event.step === "decision_profiled")?.meta.profile ?? null,
  };
}

test("flag off não lê V2 e chama provider como antes", async () => {
  const fixture = setup({ read: false });
  const result = await fixture.execute();
  assert.equal(fixture.calls.cacheRead.length, 0);
  assert.equal(fixture.calls.provider, 1);
  assert.equal(result.body.decision, "APPROVE");
});

test("HIT fresh usa evidence, não chama TechTrail e recalcula decisão", async () => {
  const fixture = setup();
  const result = await fixture.execute();
  assert.equal(fixture.calls.cacheRead.length, 1);
  assert.equal(fixture.calls.provider, 0);
  assert.deepEqual(projection(result), {
    decision: "APPROVE", score: 0,
    reasons: ["RISCO_BAIXISSIMO", "PROB_ALTISSIMA"], profile: "A",
  });
});

test("HIT preserva hard block", async () => {
  const fixture = setup({ summary: enrichmentSummary({ motivos: ["NOME DIVERGENTE"] }) });
  const result = await fixture.execute();
  assert.equal(fixture.calls.provider, 0);
  assert.equal(result.body.decision, "DECLINE");
  assert.deepEqual(result.body.reasons, ["NOME DIVERGENTE"]);
});

test("HIT preserva scoring e IMEI atual", async () => {
  const fixture = setup({
    summary: enrichmentSummary({ riscoCredito: "ALTO", probabilidadePagamento: "BAIXA" }),
    imeiResult: imeiResult("IMEI_INVALID"),
  });
  const result = await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237518" });
  assert.equal(fixture.calls.provider, 0);
  assert.equal(fixture.calls.imei, 1);
  assert.equal(result.body.score, 35);
  assert.equal(result.body.reasons.includes("IMEI_INVALID"), true);
});

test("mesma pessoa mantém lookup com contexto, proposta, bem e IMEI diferentes", async () => {
  const first = setup();
  const second = setup();
  await first.execute(SYNTHETIC_INPUT);
  await second.execute({
    ...SYNTHETIC_INPUT,
    email: "other@example.invalid", telefone_contato: "11999999999", cep: "99999999",
    valor_celular: 9999, proposalId: "OTHER", imeiCode: "490154203237518",
  });
  assert.equal(first.calls.cacheRead[0].lookupToken, second.calls.cacheRead[0].lookupToken);
  assert.equal(first.calls.provider, 0);
  assert.equal(second.calls.provider, 0);
});

test("CPF diferente produz lookup diferente e não reutiliza evidence", async () => {
  const expected = tokenService.tokenizeCpf(SYNTHETIC_INPUT.cpf);
  const fixture = setup({ lookup: (key) => key.lookupToken === expected
    ? { state: "HIT", value: evidence(), ageMs: 1 }
    : { state: "MISS" } });
  await fixture.execute({ ...SYNTHETIC_INPUT, cpf: "11111111111" });
  assert.notEqual(fixture.calls.cacheRead[0].lookupToken, expected);
  assert.equal(fixture.calls.provider, 1);
});

for (const [state, lookup] of [
  ["MISS", { state: "MISS" }],
  ["EXPIRED", { state: "EXPIRED", expiredAt: "2020-01-01T00:00:00.000Z" }],
  ["INCOMPATIBLE", { state: "INCOMPATIBLE", reason: "NORMALIZER_VERSION" }],
  ["BACKEND_ERROR", { state: "BACKEND_ERROR", errorCode: "DB_DOWN" }],
]) {
  test(`${state} chama provider exatamente uma vez`, async () => {
    const fixture = setup({ lookup });
    const result = await fixture.execute();
    assert.equal(fixture.calls.cacheRead.length, 1);
    assert.equal(fixture.calls.provider, 1);
    assert.equal(result.statusCode, 200);
  });
}

test("HIT defensivo com expiresAt vencido não é reutilizado", async () => {
  const fixture = setup({ lookup: {
    state: "HIT",
    value: evidence(enrichmentSummary({ motivos: ["NOME DIVERGENTE"] }), { expiresAt: "2020-01-01T00:00:00.000Z" }),
    ageMs: 1,
  } });
  const result = await fixture.execute();
  assert.equal(fixture.calls.provider, 1);
  assert.equal(result.body.decision, "APPROVE");
});

test("erro HMAC faz fallback para provider", async () => {
  const fixture = setup({ lookupTokenService: {
    tokenizeCpf() { throw new Error("hmac"); },
    tokenizeImei() { throw new Error("unused"); },
    hashRelevantInput() { throw new Error("unused"); },
  } });
  const result = await fixture.execute();
  assert.equal(fixture.calls.provider, 1);
  assert.equal(result.statusCode, 200);
});

test("adapter/cache indisponível faz bypass para provider", async () => {
  const fixture = setup();
  fixture.calls.cacheRead.length = 0;
  const unavailable = setup({ lookupTokenService: null });
  const result = await unavailable.execute();
  assert.equal(unavailable.calls.cacheRead.length, 0);
  assert.equal(unavailable.calls.provider, 1);
  assert.equal(result.statusCode, 200);
});

test("HIT não grava raw falso, não renova evidence e registra provenance só na auditoria", async () => {
  const fixture = setup();
  const result = await fixture.execute();
  assert.equal(fixture.calls.enrichmentRaw, 0);
  assert.equal(fixture.calls.cachePut.length, 0);
  assert.equal(result.body.events.some((event) => event.step === "cache_v2_techtrail_read"), false);
  const provenance = fixture.calls.audit[0].events.find((event) => event.step === "cache_v2_techtrail_read");
  assert.equal(provenance.meta.state, "HIT");
  assert.equal(provenance.meta.rawReference, "raw-techtrail-1");
});

test("provider e cache HIT com a mesma evidence mantêm decisão, score, reasons e profile", async () => {
  const summary = enrichmentSummary({ riscoCredito: "ALTO", probabilidadePagamento: "BAIXA" });
  const cached = setup({ summary });
  const provider = setup({ read: false, providerResult: enrichmentResult(summary) });
  const [fromCache, fromProvider] = await Promise.all([cached.execute(), provider.execute()]);
  assert.deepEqual(projection(fromCache), projection(fromProvider));
  assert.equal(cached.calls.provider, 0);
  assert.equal(provider.calls.provider, 1);
});

test("flag V1 controla somente leitura antecipada e mantém default compatível", async () => {
  const hit = { cpf: "00000000000", decision: "DECLINE", score: 99, reasons: ["V1"], ruleVersion: "v1", expiresAt: "2099-01-01T00:00:00.000Z" };
  const enabled = setup({ read: false, decisionCacheHit: hit });
  const disabled = setup({ read: false, decisionCacheHit: hit });
  const fromV1 = await enabled.execute(SYNTHETIC_INPUT, { decisionCacheV1ReadEnabled: true });
  const recalculated = await disabled.execute(SYNTHETIC_INPUT, { decisionCacheV1ReadEnabled: false });
  assert.equal(fromV1.body.source, "cache");
  assert.equal(recalculated.body.source, "engine");
  assert.equal(enabled.calls.decisionCacheGet, 1);
  assert.equal(disabled.calls.decisionCacheGet, 0);
});
