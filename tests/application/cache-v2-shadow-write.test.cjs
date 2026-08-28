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

const useCaseModule = loadAnalyzeUseCaseForCharacterization();
const foundation = loadCacheV2FoundationForCharacterization();

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
};

function scenario(options = {}) {
  const calls = {
    enrichment: 0,
    imei: 0,
    techtrailWrites: [],
    imeiWrites: [],
    replayWrites: [],
    telemetry: [],
  };
  const shadow = options.shadow === false ? undefined : {
    analysisReplayRepository: options.v2Unavailable ? null : {
      async get() { throw new Error("V2_READ_NOT_ALLOWED"); },
      async put(value) {
        if (options.replayWriteError) throw options.replayWriteError;
        calls.replayWrites.push(value);
      },
    },
    enrichmentEvidenceCache: options.v2Unavailable ? null : {
      async get() { throw new Error("V2_READ_NOT_ALLOWED"); },
      async put(value) {
        if (options.techtrailWriteError) throw options.techtrailWriteError;
        calls.techtrailWrites.push(value);
      },
    },
    imeiEvidenceCache: options.v2Unavailable ? null : {
      async get() { throw new Error("V2_READ_NOT_ALLOWED"); },
      async put(value) {
        if (options.imeiWriteError) throw options.imeiWriteError;
        calls.imeiWrites.push(value);
      },
    },
    lookupTokenService: options.lookupTokenService ??
      foundation.hmac.createHmacLookupTokenService("synthetic-shadow-secret"),
    telemetry: { record(event) { calls.telemetry.push(event); } },
    techTrailTtlDays: 30,
    imeiTtlDays: options.imeiTtlDays ?? 30,
    replayTtlDays: options.replayTtlDays ?? null,
    versions: {
      cacheSchemaVersion: "cache-v2-schema-v1",
      techTrailProviderContractVersion: "techtrail-person-v1",
      techTrailNormalizerVersion: "techtrail-normalizer-v1",
      imeiProviderContractVersion: "imei-info-v1",
      imeiNormalizerVersion: "imei-normalizer-v1",
    },
  };
  const dependencies = {
    enrichmentProvider: {
      async enrich() {
        calls.enrichment += 1;
        if (options.enrichmentPromise) return options.enrichmentPromise;
        if (options.enrichmentThrows) throw options.enrichmentThrows;
        return options.enrichment ?? enrichmentResult(enrichmentSummary());
      },
    },
    imeiProvider: {
      async check() {
        calls.imei += 1;
        return options.imei ?? imeiResult("IMEI_OK");
      },
    },
    decisionCache: { async get() { return null; }, async set() { return "2099-01-01T00:00:00.000Z"; } },
    decisionAuditRepository: { async saveDecision() {} },
    providerRawRepository: { async saveEnrichment() {}, async saveImei() {} },
    cacheV2Shadow: shadow,
  };
  const useCase = new useCaseModule.AnalyzeAntifraudUseCase(dependencies);
  return {
    calls,
    execute: (input = SYNTHETIC_INPUT, configOverrides = {}) => withMutedConsoleAsync(() =>
      useCase.execute({
        body: input,
        traceId: "shadow-trace",
        startedAtMs: Date.now(),
        config: { ...config, ...configOverrides },
      })
    ),
  };
}

function decisionProjection(result) {
  return {
    source: result.body.source,
    decision: result.body.decision,
    score: result.body.score,
    reasons: result.body.reasons,
    scoreBreakdown: result.body.scoreBreakdown,
    profile: result.body.events.find((event) => event.step === "decision_profiled")?.meta.profile ?? null,
  };
}

test("flag off não chama V2 e não exige HMAC", async () => {
  const fixture = scenario({ shadow: false });
  const result = await fixture.execute();
  assert.equal(result.body.decision, "APPROVE");
  assert.deepEqual(fixture.calls.techtrailWrites, []);
  assert.deepEqual(fixture.calls.imeiWrites, []);
  assert.deepEqual(fixture.calls.replayWrites, []);
});

test("TechTrail válida gera shadow write normalizado", async () => {
  const fixture = scenario();
  await fixture.execute();
  assert.equal(fixture.calls.techtrailWrites.length, 1);
  assert.deepEqual(fixture.calls.techtrailWrites[0].normalizedEvidence, enrichmentSummary());
  assert.equal(fixture.calls.techtrailWrites[0].completeness, "COMPLETE");
  assert.equal(fixture.calls.techtrailWrites[0].rawReference, null);
});

test("mesmo CPF mantém identidade TechTrail entre propostas e contextos diferentes", async () => {
  const first = scenario();
  const second = scenario();
  await first.execute(SYNTHETIC_INPUT);
  await second.execute({
    ...SYNTHETIC_INPUT,
    proposalId: "OTHER",
    email: "other@example.invalid",
    telefone_contato: "11999999999",
    cep: "99999999",
    valor_celular: 9999,
    salesChannel: "OTHER",
    device: { visitorId: "other-device" },
  });
  assert.equal(first.calls.techtrailWrites[0].lookupToken, second.calls.techtrailWrites[0].lookupToken);
});

for (const [label, options] of [
  ["timeout", { enrichmentPromise: new Promise(() => {}) }],
  ["erro", { enrichmentThrows: new Error("provider-error") }],
]) {
  test(`TechTrail ${label} não grava evidência`, async () => {
    const fixture = scenario(options);
    await fixture.execute(SYNTHETIC_INPUT, { enrichmentTimeoutMs: 1 });
    assert.equal(fixture.calls.techtrailWrites.length, 0);
    assert.ok(fixture.calls.telemetry.some((event) => event.name === "cache_v2_techtrail_write_skipped"));
  });
}

test("IMEI válido grava shadow quando TTL está configurado", async () => {
  const fixture = scenario({ imeiTtlDays: 7, imei: imeiResult("IMEI_OK") });
  await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237518" });
  assert.equal(fixture.calls.imeiWrites.length, 1);
  assert.equal(fixture.calls.imeiWrites[0].normalizedEvidence.reason, "IMEI_OK");
  assert.equal(fixture.calls.imeiWrites[0].service, "999");
});

test("identidade IMEI é estável para o mesmo aparelho e muda para outro", async () => {
  const a = scenario({ imeiTtlDays: 7 });
  const b = scenario({ imeiTtlDays: 7 });
  const c = scenario({ imeiTtlDays: 7 });
  await a.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237518" });
  await b.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237518", proposalId: "OTHER" });
  await c.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237526" });
  assert.equal(a.calls.imeiWrites[0].lookupToken, b.calls.imeiWrites[0].lookupToken);
  assert.notEqual(a.calls.imeiWrites[0].lookupToken, c.calls.imeiWrites[0].lookupToken);
});

for (const result of [
  { ...imeiResult("IMEI_FAIL"), timedOut: true },
  { ...imeiResult("IMEI_FAIL"), timedOut: false, httpStatus: 500 },
]) {
  test(`IMEI técnico não grava evidência (${result.timedOut ? "timeout" : "erro"})`, async () => {
    const fixture = scenario({ imeiTtlDays: 7, imei: result });
    const response = await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237518" });
    assert.equal(fixture.calls.imeiWrites.length, 0);
    assert.equal(response.body.reasons.includes("IMEI_FAIL"), true);
  });
}

test("TTL IMEI sem override usa default independente de 30 dias", async () => {
  const fixture = scenario({ imei: imeiResult("IMEI_OK") });
  await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237518" });
  assert.equal(fixture.calls.imeiWrites.length, 1);
  const written = fixture.calls.imeiWrites[0];
  assert.equal(
    (Date.parse(written.expiresAt) - Date.parse(written.fetchedAt)) / 86400000,
    30
  );
});

test("buildReplayInput é determinístico e exclui campos técnicos", () => {
  const base = useCaseModule.buildInputSummary({
    ...SYNTHETIC_INPUT,
    collectedAt: "one",
    device: { ...SYNTHETIC_INPUT.device, requestId: "one", collectedAt: "one" },
  });
  const changedTechnical = useCaseModule.buildInputSummary({
    ...SYNTHETIC_INPUT,
    collectedAt: "two",
    device: { ...SYNTHETIC_INPUT.device, requestId: "two", collectedAt: "two" },
  });
  assert.deepEqual(useCaseModule.buildReplayInput(base), useCaseModule.buildReplayInput(changedTechnical));
  assert.equal(Object.hasOwn(useCaseModule.buildReplayInput(base), "sessionId"), false);
});

test("hash replay ignora ordem, muda com campo relevante e não inclui ruleVersion", () => {
  const token = foundation.hmac.createHmacLookupTokenService("synthetic-shadow-secret");
  const replay = useCaseModule.buildReplayInput(useCaseModule.buildInputSummary(SYNTHETIC_INPUT));
  const reordered = Object.fromEntries(Object.entries(replay).reverse());
  assert.equal(token.hashRelevantInput(replay), token.hashRelevantInput(reordered));
  assert.notEqual(token.hashRelevantInput(replay), token.hashRelevantInput({ ...replay, valorCelular: 1 }));
});

test("writer sem TTL de Replay registra skipped e não escreve", async () => {
  const fixture = scenario();
  await fixture.execute();
  assert.equal(fixture.calls.replayWrites.length, 0);
  assert.ok(fixture.calls.telemetry.some((event) => event.name === "cache_v2_replay_write_skipped"));
});

test("replay configurado grava resultado, hash e analysisPolicyVersion", async () => {
  const fixture = scenario({ replayTtlDays: 2 });
  const result = await fixture.execute();
  const replay = fixture.calls.replayWrites[0];
  assert.equal(replay.proposalId, SYNTHETIC_INPUT.proposalId);
  assert.match(replay.analysisPolicyVersion,
    /^score-v1\|imei-legacy-v1\|cfg:[a-f0-9]{64}$/);
  assert.equal(replay.result.statusCode, 200);
  assert.equal(replay.result.body, result.body);
  assert.equal(typeof replay.inputHash, "string");
});

for (const [label, options] of [
  ["TechTrail", { techtrailWriteError: new Error("tech") }],
  ["IMEI", { imeiTtlDays: 7, imeiWriteError: new Error("imei") }],
  ["replay", { replayTtlDays: 2, replayWriteError: new Error("replay") }],
]) {
  test(`falha do writer ${label} não altera response`, async () => {
    const baseline = scenario({ shadow: false });
    const failing = scenario(options);
    const input = label === "IMEI" ? { ...SYNTHETIC_INPUT, imeiCode: "490154203237518" } : SYNTHETIC_INPUT;
    const expected = await baseline.execute(input);
    const actual = await failing.execute(input);
    assert.deepEqual(decisionProjection(actual), decisionProjection(expected));
  });
}

test("falha HMAC e persistência V2 indisponível não derrubam V1", async () => {
  const failingHmac = { tokenizeCpf() { throw new Error("hmac"); }, tokenizeImei() { throw new Error("hmac"); }, hashRelevantInput() { throw new Error("hmac"); } };
  const hmacFixture = scenario({ lookupTokenService: failingHmac, imeiTtlDays: 7, replayTtlDays: 2 });
  const unavailable = scenario({ v2Unavailable: true, imeiTtlDays: 7, replayTtlDays: 2 });
  const input = { ...SYNTHETIC_INPUT, imeiCode: "490154203237518" };
  const [a, b] = await Promise.all([hmacFixture.execute(input), unavailable.execute(input)]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(a.body.decision, "APPROVE");
  assert.equal(b.body.decision, "APPROVE");
});

test("shadow on/off preserva quantidade de providers e resultado decisório", async () => {
  const off = scenario({ shadow: false });
  const on = scenario({ imeiTtlDays: 7, replayTtlDays: 2 });
  const input = { ...SYNTHETIC_INPUT, imeiCode: "490154203237518" };
  const [withoutV2, withV2] = await Promise.all([off.execute(input), on.execute(input)]);
  assert.equal(off.calls.enrichment, on.calls.enrichment);
  assert.equal(off.calls.imei, on.calls.imei);
  assert.equal(off.calls.enrichment, 1);
  assert.equal(off.calls.imei, 1);
  assert.deepEqual(decisionProjection(withV2), decisionProjection(withoutV2));
  assert.deepEqual(
    withV2.body.events.map((event) => event.step),
    withoutV2.body.events.map((event) => event.step)
  );
  assert.equal(withV2.body.events.some((event) => event.step.startsWith("cache_v2_")), false);
});
