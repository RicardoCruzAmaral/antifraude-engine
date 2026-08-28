const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadAnalyzeUseCaseForCharacterization,
  loadCacheV2FoundationForCharacterization,
  withMutedConsoleAsync,
} = require("../helpers/analyze-characterization-harness.cjs");
const { SYNTHETIC_INPUT, enrichmentResult, enrichmentSummary, imeiResult } = require("../helpers/synthetic-fixtures.cjs");

const { AnalyzeAntifraudUseCase } = loadAnalyzeUseCaseForCharacterization();
const foundation = loadCacheV2FoundationForCharacterization();
const tokenService = foundation.hmac.createHmacLookupTokenService("blacklist-v1-synthetic-secret");
const VALID_IMEI = "490154203237518";

const summaries = {
  A: enrichmentSummary(),
  B1: enrichmentSummary({ riscoCredito: "ALTO", probabilidadePagamento: "ALTISSIMA" }),
  B2: enrichmentSummary({ riscoCredito: "ALTO", probabilidadePagamento: "BAIXA" }),
  C: enrichmentSummary({ riscoCredito: "ALTO", probabilidadePagamento: "BAIXISSIMA", quantidadeProcessos: 6 }),
  HARD: enrichmentSummary({ motivos: ["NOME DIVERGENTE"] }),
};

const config = {
  supabaseMissingPolicy: "continue", enrichmentTimeoutMs: 20, enrichmentMode: "mock",
  enrichmentFailDecision: "DECLINE", imeiTimeoutMs: 20, imeiPenalty: 5,
  cacheTtlDaysApprove: 30, cacheTtlDaysDecline: 30, cacheTtlSecondsTechFail: 300,
  decisionCacheV1ReadEnabled: true, imeiBlacklistV1Enabled: true,
};

function result(status, overrides = {}) {
  const clean = status === "CLEAN";
  const blacklisted = status === "BLACKLISTED";
  return {
    imei: VALID_IMEI, provider: "imei_info", service: "blacklist:777", status,
    model: "Synthetic", modelName: "Synthetic Phone", manufacturer: "Synthetic Corp",
    blacklistStatusRaw: clean ? "Clean" : blacklisted ? "Blacklisted" : "Pending",
    generalListStatus: clean ? "No" : blacklisted ? "Yes" : null,
    blacklistRecords: clean ? 0 : blacklisted ? 1 : null,
    deviceIsClean: clean ? true : blacklisted ? false : null,
    providerCreatedAt: "2026-08-01T00:00:00.000Z",
    fetchedAt: new Date(Date.now() - 1000).toISOString(), rawReference: null,
    httpStatus: status === "UNAVAILABLE" ? null : 200, latencyMs: 5,
    technicalReason: status === "UNAVAILABLE" ? "TIMEOUT" : null,
    raw: { synthetic: true }, ...overrides,
  };
}

function cachedEvidence(status, overrides = {}) {
  const value = result(status);
  return {
    lookupToken: tokenService.tokenizeImei(VALID_IMEI), provider: "imei_info", service: "blacklist:777",
    normalizedEvidence: {
      status: value.status, model: value.model, modelName: value.modelName,
      manufacturer: value.manufacturer, blacklistStatusRaw: value.blacklistStatusRaw,
      generalListStatus: value.generalListStatus, blacklistRecords: value.blacklistRecords,
      deviceIsClean: value.deviceIsClean, providerCreatedAt: value.providerCreatedAt,
    },
    fetchedAt: value.fetchedAt, expiresAt: new Date(Date.now() + 60000).toISOString(),
    providerContractVersion: "imei-info-blacklist-v1",
    normalizerVersion: "imei-blacklist-normalizer-v2",
    cacheSchemaVersion: "cache-v2-schema-v1", completeness: "COMPLETE",
    rawReference: "blacklist-artifact-1", ...overrides,
  };
}

function setup(options = {}) {
  const calls = {
    legacy: 0, blacklist: 0, cacheRead: [], cachePut: [], raw: 0,
    audit: [], telemetry: [], v1Get: 0, v1Set: 0,
  };
  const service = Object.hasOwn(options, "service") ? options.service : "blacklist:777";
  const blacklistProvider = {
    provider: "imei_info", service,
    normalizeAndValidate(imeiCode) {
      const normalizedImei = String(imeiCode || "").replace(/\D/g, "");
      return { normalizedImei, valid: normalizedImei === VALID_IMEI || normalizedImei === "490154203237526" };
    },
    async check() {
      calls.blacklist += 1;
      if (options.providerThrows) throw options.providerThrows;
      return options.providerResult ?? result("CLEAN", { service });
    },
  };
  const cache = {
    async get(key) {
      calls.cacheRead.push(key);
      if (options.cacheThrows) throw options.cacheThrows;
      return options.lookup ?? { state: "MISS" };
    },
    async put(value) { calls.cachePut.push(value); },
  };
  const read = options.cacheRead === false ? undefined : {
    imeiEvidenceCache: options.cacheUnavailable ? null : cache,
    lookupTokenService: options.lookupTokenService === undefined ? tokenService : options.lookupTokenService,
    telemetry: { record(event) { calls.telemetry.push(event); } },
    provider: "imei_info", service,
    providerContractVersion: "imei-info-blacklist-v1",
    normalizerVersion: "imei-blacklist-normalizer-v2",
    cacheSchemaVersion: "cache-v2-schema-v1",
  };
  const shadow = options.shadow ? {
    analysisReplayRepository: { async get() { throw new Error("REPLAY_READ_FORBIDDEN"); }, async put() {} },
    enrichmentEvidenceCache: { async get() { throw new Error("TECH_READ_FORBIDDEN"); }, async put() {} },
    imeiEvidenceCache: cache,
    lookupTokenService: tokenService,
    telemetry: { record(event) { calls.telemetry.push(event); } },
    techTrailTtlDays: 30, imeiTtlDays: options.imeiTtlDays ?? 30, replayTtlDays: null,
    versions: {
      cacheSchemaVersion: "cache-v2-schema-v1",
      techTrailProviderContractVersion: "techtrail-person-v1", techTrailNormalizerVersion: "techtrail-normalizer-v1",
      imeiProviderContractVersion: "imei-info-v1", imeiNormalizerVersion: "imei-normalizer-v2",
      imeiBlacklistProviderContractVersion: "imei-info-blacklist-v1",
      imeiBlacklistNormalizerVersion: "imei-blacklist-normalizer-v2",
    },
  } : undefined;
  const useCase = new AnalyzeAntifraudUseCase({
    enrichmentProvider: { async enrich() { return enrichmentResult(options.summary ?? summaries.B1); } },
    imeiProvider: { async check() { calls.legacy += 1; return imeiResult("IMEI_OK"); } },
    imeiBlacklistProvider: blacklistProvider,
    decisionCache: {
      async get() { calls.v1Get += 1; return options.v1Hit ?? null; },
      async set() { calls.v1Set += 1; return "2099-01-01T00:00:00.000Z"; },
    },
    decisionAuditRepository: { async saveDecision(row) { calls.audit.push(row); } },
    providerRawRepository: {
      async saveEnrichment() {}, async saveImei() {},
      async saveImeiBlacklist() { calls.raw += 1; },
    },
    cacheV2Shadow: shadow,
    cacheV2ImeiBlacklistRead: read,
    imeiBlacklistTelemetry: { record(event) { calls.telemetry.push(event); } },
  });
  return {
    calls,
    execute(input = { ...SYNTHETIC_INPUT, imeiCode: VALID_IMEI }, overrides = {}) {
      return withMutedConsoleAsync(() => useCase.execute({
        body: input, traceId: "blacklist-v1-trace", startedAtMs: Date.now(),
        config: { ...config, ...overrides },
      }));
    },
  };
}

function profile(response) {
  return response.body.events.find((event) => event.step === "decision_profiled")?.meta.profile ?? null;
}

for (const [baseProfile, eventName] of [["A", "IMEI_BLACKLIST_SKIPPED_PROFILE_A"], ["C", "IMEI_BLACKLIST_SKIPPED_PROFILE_C"]]) {
  test(`perfil ${baseProfile} não consulta cache nem provider Blacklist`, async () => {
    const fixture = setup({ summary: summaries[baseProfile] });
    const response = await fixture.execute();
    assert.equal(fixture.calls.cacheRead.length, 0);
    assert.equal(fixture.calls.blacklist, 0);
    assert.equal(fixture.calls.legacy, 0);
    assert.equal(fixture.calls.audit[0].events.some((event) => event.step === eventName), true);
    assert.equal(response.body.decision, baseProfile === "C" ? "DECLINE" : "APPROVE");
  });
}

test("hard block não consulta cache nem qualquer provider IMEI", async () => {
  const fixture = setup({ summary: summaries.HARD });
  await fixture.execute();
  assert.equal(fixture.calls.cacheRead.length, 0);
  assert.equal(fixture.calls.blacklist, 0);
  assert.equal(fixture.calls.legacy, 0);
  assert.equal(fixture.calls.audit[0].events.some((event) => event.step === "IMEI_BLACKLIST_SKIPPED_HARD_BLOCK"), true);
});

for (const baseProfile of ["B1", "B2"]) {
  test(`${baseProfile} sem IMEI não consulta cache/provider e mantém decisão da pessoa`, async () => {
    const fixture = setup({ summary: summaries[baseProfile] });
    const response = await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: null });
    assert.equal(fixture.calls.cacheRead.length, 0);
    assert.equal(fixture.calls.blacklist, 0);
    assert.equal(response.body.decision, "APPROVE");
    assert.equal(profile(response), baseProfile);
    assert.equal(fixture.calls.audit[0].events.some((event) => event.step === "IMEI_BLACKLIST_SKIPPED_NO_IMEI"), true);
  });

  test(`${baseProfile} CLEAN mantém score, profile e APPROVE`, async () => {
    const fixture = setup({ summary: summaries[baseProfile], cacheRead: false, providerResult: result("CLEAN") });
    const response = await fixture.execute();
    assert.equal(fixture.calls.blacklist, 1);
    assert.equal(response.body.decision, "APPROVE");
    assert.equal(profile(response), baseProfile);
    assert.equal(response.body.reasons.includes("IMEI_BLACKLISTED"), false);
    assert.equal(fixture.calls.audit[0].events.some((event) => event.step === "IMEI_BLACKLIST_CLEAN"), true);
  });

  test(`${baseProfile} BLACKLISTED força DECLINE sem mudar score/profile`, async () => {
    const fixture = setup({ summary: summaries[baseProfile], cacheRead: false, providerResult: result("BLACKLISTED") });
    const response = await fixture.execute();
    assert.equal(response.body.decision, "DECLINE");
    assert.equal(profile(response), baseProfile);
    assert.equal(response.body.reasons.at(-1), "IMEI_BLACKLISTED");
    assert.equal(response.body.score, baseProfile === "B1" ? 15 : 30);
    assert.equal(response.body.scoreBreakdown.some((item) => item.rule === "IMEI_BLACKLISTED"), false);
    assert.equal(fixture.calls.audit[0].events.some((event) => event.step === "IMEI_BLACKLISTED"), true);
  });
}

for (const status of ["UNKNOWN", "UNAVAILABLE"]) {
  test(`${status} não vira fraude nem acrescenta pontos`, async () => {
    const fixture = setup({ cacheRead: false, providerResult: result(status) });
    const response = await fixture.execute();
    assert.equal(response.body.decision, "APPROVE");
    assert.equal(response.body.score, 15);
    assert.equal(response.body.reasons.some((reason) => reason.includes("BLACKLIST")), false);
    const eventName = status === "UNKNOWN" ? "IMEI_BLACKLIST_UNKNOWN" : "IMEI_BLACKLIST_UNAVAILABLE";
    assert.equal(fixture.calls.audit[0].events.some((event) => event.step === eventName), true);
  });
}

test("IMEI inválido local preserva IMEI_INVALID +5 e custa zero", async () => {
  const fixture = setup({ summary: summaries.B1 });
  const response = await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "123" });
  assert.equal(fixture.calls.cacheRead.length, 0);
  assert.equal(fixture.calls.blacklist, 0);
  assert.equal(response.body.score, 20);
  assert.equal(response.body.reasons.includes("IMEI_INVALID"), true);
});

test("B1 no limite 25 + IMEI_INVALID preserva peso e migra para B2", async () => {
  const fixture = setup({
    summary: enrichmentSummary({ riscoCredito: "MEDIO", probabilidadePagamento: "ALTISSIMA", quantidadeProcessos: 4 }),
  });
  const response = await fixture.execute({ ...SYNTHETIC_INPUT, imeiCode: "123" });
  assert.equal(response.body.score, 30);
  assert.equal(profile(response), "B2");
  assert.equal(response.body.decision, "APPROVE");
  assert.equal(response.body.reasons.includes("IMEI_INVALID"), true);
});

test("B2 no limite 45 + IMEI_INVALID preserva peso e migra para C/DECLINE", async () => {
  const fixture = setup({
    summary: enrichmentSummary({
      motivos: ["CEP DIVERGENTE"], riscoCredito: "ALTO",
      probabilidadePagamento: "BAIXISSIMA", quantidadeProcessos: 0,
    }),
  });
  const response = await fixture.execute({
    ...SYNTHETIC_INPUT, valor_celular: 5001, imeiCode: "123",
  });
  assert.equal(response.body.score, 50);
  assert.equal(profile(response), "C");
  assert.equal(response.body.decision, "DECLINE");
  assert.equal(response.body.reasons.includes("IMEI_INVALID"), true);
});

for (const status of ["CLEAN", "BLACKLISTED"]) {
  test(`cache HIT ${status} faz zero provider calls`, async () => {
    const fixture = setup({ lookup: { state: "HIT", value: cachedEvidence(status), ageMs: 1000 } });
    const response = await fixture.execute();
    assert.equal(fixture.calls.blacklist, 0);
    assert.equal(response.body.decision, status === "BLACKLISTED" ? "DECLINE" : "APPROVE");
  });
}

test("cache HIT UNKNOWN é reutilizado sem fraude nem provider", async () => {
  const fixture = setup({ lookup: { state: "HIT", value: cachedEvidence("UNKNOWN"), ageMs: 1000 } });
  const response = await fixture.execute();
  assert.equal(fixture.calls.blacklist, 0);
  assert.equal(response.body.decision, "APPROVE");
  assert.equal(response.body.score, 15);
});

test("artifact normalizer-v1 é incompatível com normalizer-v2 e força cold miss", async () => {
  const oldArtifact = cachedEvidence("UNKNOWN", {
    normalizerVersion: "imei-blacklist-normalizer-v1",
  });
  const fixture = setup({ lookup: { state: "HIT", value: oldArtifact, ageMs: 1000 } });
  const response = await fixture.execute();
  assert.equal(fixture.calls.cacheRead[0].normalizerVersion, "imei-blacklist-normalizer-v2");
  assert.equal(fixture.calls.blacklist, 1);
  assert.equal(response.body.decision, "APPROVE");
  const miss = fixture.calls.audit[0].events.find((event) => event.step === "IMEI_BLACKLIST_CACHE_MISS");
  assert.equal(miss.meta.state, "INCOMPATIBLE");
});

for (const [state, lookup] of [
  ["MISS", { state: "MISS" }],
  ["EXPIRED", { state: "EXPIRED", expiredAt: "2020-01-01T00:00:00.000Z" }],
  ["INCOMPATIBLE", { state: "INCOMPATIBLE", reason: "PROVIDER_CONTRACT_VERSION" }],
  ["BACKEND_ERROR", { state: "BACKEND_ERROR", errorCode: "DB_DOWN" }],
]) {
  test(`cache ${state} chama somente provider Blacklist exatamente uma vez`, async () => {
    const fixture = setup({ lookup });
    const response = await fixture.execute();
    assert.equal(fixture.calls.blacklist, 1);
    assert.equal(fixture.calls.legacy, 0);
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.calls.audit[0].events.some((event) => event.step === "IMEI_BLACKLIST_CACHE_MISS"), true);
  });
}

test("HMAC/cache indisponível faz fallback sem transformar erro em fraude", async () => {
  const fixture = setup({ lookupTokenService: { tokenizeImei() { throw new Error("hmac"); } } });
  const response = await fixture.execute();
  assert.equal(fixture.calls.blacklist, 1);
  assert.equal(response.body.decision, "APPROVE");
});

test("service ID ausente não chama provider nem gera risco", async () => {
  const fixture = setup({ service: null });
  const response = await fixture.execute();
  assert.equal(fixture.calls.cacheRead.length, 0);
  assert.equal(fixture.calls.blacklist, 0);
  assert.equal(response.body.decision, "APPROVE");
  assert.equal(fixture.calls.audit[0].events.some((event) => event.step === "IMEI_BLACKLIST_UNAVAILABLE"), true);
});

test("modelo declarado, CPF e proposta não mudam identidade/service Blacklist", async () => {
  const keys = [];
  for (const [index, modelo] of ["iPhone 15", "Galaxy S25", "Motorola Edge", "Xiaomi Poco"].entries()) {
    const fixture = setup();
    await fixture.execute({ ...SYNTHETIC_INPUT, cpf: String(index + 1).padStart(11, "0"), proposalId: `P${index}`, modelo_declarado: modelo, imeiCode: VALID_IMEI });
    keys.push(fixture.calls.cacheRead[0]);
    assert.equal(fixture.calls.blacklist, 1);
    assert.equal(fixture.calls.legacy, 0);
  }
  for (const key of keys) assert.deepEqual(key, keys[0]);
  assert.equal(keys[0].service, "blacklist:777");
});

test("IMEI diferente muda somente lookup token factual", async () => {
  const first = setup();
  const second = setup();
  await first.execute();
  await second.execute({ ...SYNTHETIC_INPUT, imeiCode: "490154203237526" });
  assert.notEqual(first.calls.cacheRead[0].lookupToken, second.calls.cacheRead[0].lookupToken);
  assert.deepEqual({ ...first.calls.cacheRead[0], lookupToken: null }, { ...second.calls.cacheRead[0], lookupToken: null });
});

test("HIT não grava raw, não renova TTL e deixa provenance só na auditoria", async () => {
  const fixture = setup({ lookup: { state: "HIT", value: cachedEvidence("CLEAN"), ageMs: 1000 }, shadow: true });
  const response = await fixture.execute();
  assert.equal(fixture.calls.blacklist, 0);
  assert.equal(fixture.calls.raw, 0);
  assert.equal(fixture.calls.cachePut.length, 0);
  assert.equal(response.body.events.some((event) => event.step.startsWith("IMEI_BLACKLIST")), false);
  const provenance = fixture.calls.audit[0].events.find((event) => event.step === "IMEI_BLACKLIST_CACHE_HIT");
  assert.equal(provenance.meta.rawReference, "blacklist-artifact-1");
});

test("HIT com status incompatível com sinais factuais é rejeitado", async () => {
  const poisoned = cachedEvidence("CLEAN");
  poisoned.normalizedEvidence.status = "BLACKLISTED";
  const fixture = setup({ lookup: { state: "HIT", value: poisoned, ageMs: 1000 } });
  const response = await fixture.execute();
  assert.equal(fixture.calls.blacklist, 1);
  assert.equal(response.body.decision, "APPROVE");
  const miss = fixture.calls.audit[0].events.find((event) => event.step === "IMEI_BLACKLIST_CACHE_MISS");
  assert.equal(miss.meta.state, "INCOMPATIBLE");
});

test("HIT defensivo vencido não é reutilizado", async () => {
  const expired = cachedEvidence("BLACKLISTED", { expiresAt: "2020-01-01T00:00:00.000Z" });
  const fixture = setup({ lookup: { state: "HIT", value: expired, ageMs: 1000 } });
  const response = await fixture.execute();
  assert.equal(fixture.calls.blacklist, 1);
  assert.equal(response.body.decision, "APPROVE");
});

test("HIT com fetchedAt futuro ou intervalo invertido não é reutilizado", async () => {
  const future = new Date(Date.now() + 60000).toISOString();
  const later = new Date(Date.now() + 120000).toISOString();
  const futureFixture = setup({ lookup: { state: "HIT", value: cachedEvidence("BLACKLISTED", { fetchedAt: future, expiresAt: later }), ageMs: 0 } });
  const invertedFixture = setup({ lookup: { state: "HIT", value: cachedEvidence("BLACKLISTED", { fetchedAt: later, expiresAt: future }), ageMs: 0 } });
  const [futureResponse, invertedResponse] = await Promise.all([futureFixture.execute(), invertedFixture.execute()]);
  assert.equal(futureFixture.calls.blacklist, 1);
  assert.equal(invertedFixture.calls.blacklist, 1);
  assert.equal(futureResponse.body.decision, "APPROVE");
  assert.equal(invertedResponse.body.decision, "APPROVE");
});

test("MISS válido grava fato sem IMEI/modelo declarado e TTL de 30 dias", async () => {
  const fixture = setup({ shadow: true, providerResult: result("CLEAN") });
  await fixture.execute({ ...SYNTHETIC_INPUT, modelo_declarado: "Galaxy", imeiCode: VALID_IMEI });
  const write = fixture.calls.cachePut.find((item) => item.service === "blacklist:777");
  assert.ok(write);
  assert.equal(Object.hasOwn(write.normalizedEvidence, "imei"), false);
  assert.equal(Object.hasOwn(write.normalizedEvidence, "modelo_declarado"), false);
  assert.equal(Object.hasOwn(write.normalizedEvidence, "brandExpected"), false);
  assert.equal((Date.parse(write.expiresAt) - Date.parse(write.fetchedAt)) / 86400000, 30);
});

test("override IMEI_CACHE_TTL_DAYS do writer Blacklist permanece independente", async () => {
  const fixture = setup({ shadow: true, imeiTtlDays: 7, providerResult: result("CLEAN") });
  await fixture.execute();
  const write = fixture.calls.cachePut.find((item) => item.service === "blacklist:777");
  assert.equal((Date.parse(write.expiresAt) - Date.parse(write.fetchedAt)) / 86400000, 7);
});

test("resultado factual incoerente do provider vira UNAVAILABLE e não sobrescreve cache", async () => {
  const inconsistent = result("BLACKLISTED", {
    blacklistStatusRaw: "Clean", generalListStatus: "No",
    blacklistRecords: 0, deviceIsClean: true,
  });
  const fixture = setup({ shadow: true, providerResult: inconsistent });
  const response = await fixture.execute();
  assert.equal(response.body.decision, "APPROVE");
  assert.equal(fixture.calls.cachePut.some((item) => item.service === "blacklist:777"), false);
  assert.equal(fixture.calls.audit[0].events.some((event) => event.step === "IMEI_BLACKLIST_UNAVAILABLE"), true);
});

test("resultado do provider com IMEI/service divergente nunca força DECLINE", async () => {
  const fixture = setup({
    shadow: true,
    providerResult: result("BLACKLISTED", { imei: "490154203237526", service: "blacklist:999" }),
  });
  const response = await fixture.execute();
  assert.equal(response.body.decision, "APPROVE");
  assert.equal(response.body.reasons.includes("IMEI_BLACKLISTED"), false);
  assert.equal(fixture.calls.cachePut.some((item) => item.service?.startsWith("blacklist:")), false);
});

test("telemetria emite exatamente um estado de cache e um status factual", async () => {
  const hit = setup({ lookup: { state: "HIT", value: cachedEvidence("CLEAN"), ageMs: 1 } });
  await hit.execute();
  assert.equal(hit.calls.telemetry.filter((event) => event.name === "IMEI_BLACKLIST_CACHE_HIT").length, 1);
  assert.equal(hit.calls.telemetry.filter((event) => event.name === "IMEI_BLACKLIST_CLEAN").length, 1);

  const miss = setup({ lookup: { state: "MISS" } });
  await miss.execute();
  assert.equal(miss.calls.telemetry.filter((event) => event.name === "IMEI_BLACKLIST_CACHE_MISS").length, 1);
  assert.equal(miss.calls.telemetry.filter((event) => event.name === "IMEI_BLACKLIST_CLEAN").length, 1);
});

test("UNAVAILABLE não grava evidência reutilizável", async () => {
  const fixture = setup({ shadow: true, providerResult: result("UNAVAILABLE") });
  await fixture.execute();
  assert.equal(fixture.calls.cachePut.some((item) => item.service === "blacklist:777"), false);
});

test("flag OFF mantém provider/cache/decision cache legados", async () => {
  const fixture = setup({ lookup: { state: "HIT", value: cachedEvidence("BLACKLISTED"), ageMs: 1 } });
  const response = await fixture.execute(undefined, { imeiBlacklistV1Enabled: false });
  assert.equal(fixture.calls.v1Get, 1);
  assert.equal(fixture.calls.legacy, 1);
  assert.equal(fixture.calls.blacklist, 0);
  assert.equal(fixture.calls.cacheRead.length, 0);
  assert.equal(response.body.ruleVersion, "score-v1");
});

test("flag ON ignora HIT V1, não escreve V1 e usa ruleVersion isolada", async () => {
  const fixture = setup({ cacheRead: false, providerResult: result("BLACKLISTED"), v1Hit: { decision: "APPROVE", score: 0, reasons: [], ruleVersion: "score-v1" } });
  const response = await fixture.execute();
  assert.equal(fixture.calls.v1Get, 0);
  assert.equal(fixture.calls.v1Set, 0);
  assert.equal(response.body.decision, "DECLINE");
  assert.equal(response.body.ruleVersion, "score-v1+imei-blacklist-v1");
});
