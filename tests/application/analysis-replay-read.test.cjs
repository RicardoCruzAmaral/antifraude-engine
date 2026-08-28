const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadAnalyzeUseCaseForCharacterization,
  loadCacheV2FoundationForCharacterization,
  withIsolatedEnvironmentAsync,
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

const defaultConfig = {
  supabaseMissingPolicy: "continue",
  enrichmentTimeoutMs: 20,
  enrichmentMode: "mock",
  enrichmentFailDecision: "DECLINE",
  imeiTimeoutMs: 20,
  imeiPenalty: 5,
  cacheTtlDaysApprove: 30,
  cacheTtlDaysDecline: 30,
  cacheTtlSecondsTechFail: 300,
  decisionCacheV1ReadEnabled: true,
  imeiBlacklistV1Enabled: false,
};

function keyOf(key) {
  return JSON.stringify([
    key.proposalId,
    key.inputHash,
    key.analysisPolicyVersion,
    key.cacheSchemaVersion,
  ]);
}

function memoryRepository(options = {}) {
  const entries = new Map();
  const calls = { gets: [], puts: [] };
  return {
    calls,
    entries,
    repository: {
      async get(key) {
        calls.gets.push(key);
        if (options.get) return options.get(key);
        const value = entries.get(keyOf(key));
        return value
          ? { state: "HIT", value, ageMs: Math.max(0, Date.now() - Date.parse(value.createdAt)) }
          : { state: "MISS" };
      },
      async put(entry) {
        calls.puts.push(entry);
        entries.set(keyOf(entry), entry);
      },
    },
  };
}

function hitFor(key, result, overrides = {}) {
  return {
    state: "HIT",
    ageMs: 1000,
    value: {
      ...key,
      result,
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ...overrides,
    },
  };
}

function fixture(options = {}) {
  const calls = {
    enrichment: 0,
    imei: 0,
    blacklist: 0,
    decisionGet: 0,
    decisionSet: 0,
    techTrailCache: 0,
    imeiCache: 0,
    audit: 0,
    raw: 0,
    telemetry: [],
  };
  const replay = options.replay ?? memoryRepository();
  const tokenService = options.tokenService ??
    foundation.hmac.createHmacLookupTokenService("analysis-replay-test-secret");
  const telemetry = { record(event) { calls.telemetry.push(event); } };
  const replayRead = options.replayRead === false ? undefined : {
    analysisReplayRepository: replay.repository,
    lookupTokenService: tokenService,
    telemetry,
    cacheSchemaVersion: "cache-v2-schema-v1",
  };
  const shadow = options.shadow ? {
    analysisReplayRepository: replay.repository,
    enrichmentEvidenceCache: null,
    imeiEvidenceCache: null,
    lookupTokenService: tokenService,
    telemetry,
    techTrailTtlDays: 30,
    imeiTtlDays: 30,
    replayTtlDays: options.replayTtlDays ?? 30,
    versions: {
      cacheSchemaVersion: "cache-v2-schema-v1",
      techTrailProviderContractVersion: "techtrail-person-v1",
      techTrailNormalizerVersion: "techtrail-normalizer-v1",
      imeiProviderContractVersion: "imei-info-v1",
      imeiNormalizerVersion: "imei-normalizer-v2",
      imeiBlacklistProviderContractVersion: "imei-info-blacklist-v1",
      imeiBlacklistNormalizerVersion: "imei-blacklist-normalizer-v1",
    },
  } : undefined;
  const dependencies = {
    enrichmentProvider: {
      async enrich() {
        calls.enrichment += 1;
        return options.enrichment ?? enrichmentResult(enrichmentSummary());
      },
    },
    imeiProvider: {
      async check() {
        calls.imei += 1;
        return imeiResult("IMEI_OK");
      },
    },
    imeiBlacklistProvider: {
      provider: "imei_info",
      service: "blacklist:777",
      normalizeAndValidate(imeiCode) { return { normalizedImei: imeiCode, valid: true }; },
      async check() {
        calls.blacklist += 1;
        return options.blacklistResult;
      },
    },
    decisionCache: {
      async get() { calls.decisionGet += 1; return null; },
      async set() { calls.decisionSet += 1; return "2099-01-01T00:00:00.000Z"; },
    },
    decisionAuditRepository: { async saveDecision() { calls.audit += 1; } },
    providerRawRepository: {
      async saveEnrichment() { calls.raw += 1; },
      async saveImei() { calls.raw += 1; },
      async saveImeiBlacklist() { calls.raw += 1; },
    },
    cacheV2ReplayRead: replayRead,
    cacheV2Shadow: shadow,
    cacheV2TechTrailRead: options.proveCacheBypass ? {
      enrichmentEvidenceCache: { async get() { calls.techTrailCache += 1; throw new Error("TECHTRAIL_CACHE_FORBIDDEN"); } },
      lookupTokenService: tokenService,
      telemetry,
      provider: "mock",
      providerContractVersion: "techtrail-person-v1",
      normalizerVersion: "techtrail-normalizer-v1",
      cacheSchemaVersion: "cache-v2-schema-v1",
    } : undefined,
    cacheV2ImeiRead: options.proveCacheBypass ? {
      imeiEvidenceCache: { async get() { calls.imeiCache += 1; throw new Error("IMEI_CACHE_FORBIDDEN"); } },
      lookupTokenService: tokenService,
      telemetry,
      provider: "imei_info",
      providerContractVersion: "imei-info-v1",
      normalizerVersion: "imei-normalizer-v2",
      cacheSchemaVersion: "cache-v2-schema-v1",
      resolveContext() { throw new Error("IMEI_CONTEXT_FORBIDDEN"); },
    } : undefined,
    cacheV2ImeiBlacklistRead: options.proveCacheBypass ? {
      imeiEvidenceCache: { async get() { calls.imeiCache += 1; throw new Error("IMEI_BLACKLIST_CACHE_FORBIDDEN"); } },
      lookupTokenService: tokenService,
      telemetry,
      provider: "imei_info",
      service: "blacklist:777",
      providerContractVersion: "imei-info-blacklist-v1",
      normalizerVersion: "imei-blacklist-normalizer-v1",
      cacheSchemaVersion: "cache-v2-schema-v1",
    } : undefined,
  };
  const useCase = new useCaseModule.AnalyzeAntifraudUseCase(dependencies);
  let execution = 0;
  return {
    calls,
    replay,
    execute(body = { ...SYNTHETIC_INPUT, imeiCode: "490154203237518" }, config = {}) {
      execution += 1;
      return withMutedConsoleAsync(() => useCase.execute({
        body,
        traceId: `replay-trace-${execution}`,
        startedAtMs: Date.now(),
        config: { ...defaultConfig, ...config },
      }));
    },
  };
}

test("FLAG OFF não lê Replay e preserva o fluxo atual", async () => {
  const replay = memoryRepository({ get() { throw new Error("REPLAY_READ_FORBIDDEN"); } });
  const run = fixture({ replay, replayRead: false });
  const result = await run.execute();
  assert.equal(result.body.source, "engine");
  assert.equal(replay.calls.gets.length, 0);
  assert.equal(run.calls.enrichment, 1);
  assert.equal(run.calls.imei, 1);
});

test("HIT devolve status/body exatos e pula todos os caches, providers e engine", async () => {
  const cachedBody = { exact: { decision: "APPROVE", marker: [1, 2, 3] } };
  const replay = memoryRepository({
    get(key) { return hitFor(key, { statusCode: 202, body: cachedBody }); },
  });
  const run = fixture({ replay, shadow: true, proveCacheBypass: true });
  const result = await run.execute(undefined, { imeiBlacklistV1Enabled: true });
  assert.equal(result.statusCode, 202);
  assert.strictEqual(result.body, cachedBody);
  assert.equal(run.calls.decisionGet, 0);
  assert.equal(run.calls.decisionSet, 0);
  assert.equal(run.calls.techTrailCache, 0);
  assert.equal(run.calls.imeiCache, 0);
  assert.equal(run.calls.enrichment, 0);
  assert.equal(run.calls.imei, 0);
  assert.equal(run.calls.blacklist, 0);
  assert.equal(run.calls.audit, 0);
  assert.equal(run.calls.raw, 0);
  assert.equal(replay.calls.puts.length, 0);
});

for (const [state, lookup] of [
  ["MISS", { state: "MISS" }],
  ["EXPIRED", { state: "EXPIRED", expiredAt: "2020-01-01T00:00:00.000Z" }],
  ["INCOMPATIBLE", { state: "INCOMPATIBLE", reason: "ANALYSIS_POLICY_VERSION" }],
  ["BACKEND_ERROR", { state: "BACKEND_ERROR", errorCode: "DB_DOWN" }],
]) {
  test(`${state} executa o fluxo normal exatamente uma vez`, async () => {
    const replay = memoryRepository({ get() { return lookup; } });
    const run = fixture({ replay });
    const result = await run.execute();
    assert.equal(result.body.source, "engine");
    assert.equal(run.calls.decisionGet, 1);
    assert.equal(run.calls.enrichment, 1);
    assert.equal(run.calls.imei, 1);
  });
}

test("erro de HMAC/lookup faz fallback e não derruba a análise", async () => {
  const tokenService = {
    tokenizeCpf() { throw new Error("unused"); },
    tokenizeImei() { throw new Error("unused"); },
    hashRelevantInput() { throw new Error("HMAC_FAILED"); },
  };
  const run = fixture({ tokenService });
  const result = await run.execute();
  assert.equal(result.body.source, "engine");
  assert.equal(run.calls.enrichment, 1);
  assert.equal(run.calls.imei, 1);
  assert.ok(run.calls.telemetry.some((event) =>
    event.name === "cache_v2_replay_read_backend_error"));
});

test("hash usa input normalizado, ignora ordem/técnicos e inclui todos os campos relevantes", () => {
  const token = foundation.hmac.createHmacLookupTokenService("analysis-replay-hash-secret");
  const summarized = useCaseModule.buildInputSummary({
    ...SYNTHETIC_INPUT,
    collectedAt: "one",
    device: { ...SYNTHETIC_INPUT.device, requestId: "one", collectedAt: "one" },
  });
  const replayInput = useCaseModule.buildReplayInput(summarized);
  const baseHash = token.hashRelevantInput(replayInput);
  const reordered = Object.fromEntries(Object.entries(replayInput).reverse());
  assert.equal(token.hashRelevantInput(reordered), baseHash);

  const technicalChange = useCaseModule.buildReplayInput(useCaseModule.buildInputSummary({
    ...SYNTHETIC_INPUT,
    collectedAt: "two",
    sessionId: "transport-session-two",
    device: { ...SYNTHETIC_INPUT.device, requestId: "two", collectedAt: "two", extra: "ignored" },
  }));
  assert.equal(token.hashRelevantInput(technicalChange), baseHash);

  for (const change of [
    { cpf: "99999999999" },
    { imeiCode: "490154203237526" },
    { valor_celular: Number(SYNTHETIC_INPUT.valor_celular) + 1 },
    { nome: "Outro Nome" },
    { email: "outro@example.invalid" },
    { telefone_contato: "11999999999" },
    { cep: "99999999" },
    { partnerCode: "OTHER" },
    { salesChannel: "OTHER" },
    { proposalId: "OTHER" },
    { modelo_declarado: "OTHER" },
    { device: { ...SYNTHETIC_INPUT.device, visitorId: "other-device" } },
  ]) {
    const changed = useCaseModule.buildReplayInput(useCaseModule.buildInputSummary({
      ...SYNTHETIC_INPUT,
      ...change,
    }));
    assert.notEqual(token.hashRelevantInput(changed), baseHash, JSON.stringify(change));
  }
});

test("mesma proposal e input reutiliza; mesma proposal com input diferente executa novamente", async () => {
  const run = fixture({ shadow: true });
  const first = await run.execute();
  const second = await run.execute();
  assert.strictEqual(second.body, run.replay.calls.puts[0].result.body);
  assert.equal(first.body.source, "engine");
  assert.equal(run.calls.enrichment, 1);
  assert.equal(run.calls.imei, 1);

  const changed = await run.execute({
    ...SYNTHETIC_INPUT,
    imeiCode: "490154203237518",
    valor_celular: Number(SYNTHETIC_INPUT.valor_celular) + 1,
  });
  assert.equal(changed.body.source, "engine");
  assert.equal(run.calls.enrichment, 2);
  assert.equal(run.calls.imei, 2);
});

for (const [fromBlacklist, toBlacklist] of [[false, true], [true, false]]) {
  test(`política ${fromBlacklist ? "Blacklist" : "legada"} não é reutilizada pela ${toBlacklist ? "Blacklist" : "legada"}`, async () => {
    const run = fixture({ shadow: true });
    await run.execute({ ...SYNTHETIC_INPUT, imeiCode: null }, { imeiBlacklistV1Enabled: fromBlacklist });
    const before = run.calls.enrichment;
    await run.execute({ ...SYNTHETIC_INPUT, imeiCode: null }, { imeiBlacklistV1Enabled: toBlacklist });
    assert.equal(run.calls.enrichment, before + 1);
    assert.match(run.replay.calls.gets[0].analysisPolicyVersion,
      new RegExp(`^score-v1\\|imei-${fromBlacklist ? "blacklist" : "legacy"}-v1\\|cfg:[a-f0-9]{64}$`));
    assert.match(run.replay.calls.gets[1].analysisPolicyVersion,
      new RegExp(`^score-v1\\|imei-${toBlacklist ? "blacklist" : "legacy"}-v1\\|cfg:[a-f0-9]{64}$`));
  });
}

test("mesma request e mesmos pesos permite HIT; alterar um peso força MISS", async () => {
  const run = fixture({ shadow: true });
  const body = { ...SYNTHETIC_INPUT, imeiCode: null };

  await withIsolatedEnvironmentAsync({ SCORE_RISCO_MEDIO: "5" }, () => run.execute(body));
  await withIsolatedEnvironmentAsync({ SCORE_RISCO_MEDIO: "5" }, () => run.execute(body));
  assert.equal(run.calls.enrichment, 1);
  assert.equal(run.replay.calls.puts.length, 1);

  await withIsolatedEnvironmentAsync({ SCORE_RISCO_MEDIO: "6" }, () => run.execute(body));
  assert.equal(run.calls.enrichment, 2);
  assert.equal(run.replay.calls.puts.length, 2);
  assert.notEqual(
    run.replay.calls.gets[0].analysisPolicyVersion,
    run.replay.calls.gets[2].analysisPolicyVersion
  );
});

test("TTL, flags de cache e HMAC não compõem a política decisória", async () => {
  const run = fixture({ shadow: true });
  const body = { ...SYNTHETIC_INPUT, imeiCode: null };
  await withIsolatedEnvironmentAsync({
    ANALYSIS_REPLAY_TTL_DAYS: "7",
    CACHE_V2_WRITE_ENABLED: "false",
    EVIDENCE_LOOKUP_HMAC_KEY: "first-irrelevant-secret",
  }, () => run.execute(body));
  await withIsolatedEnvironmentAsync({
    ANALYSIS_REPLAY_TTL_DAYS: "60",
    CACHE_V2_WRITE_ENABLED: "true",
    EVIDENCE_LOOKUP_HMAC_KEY: "second-irrelevant-secret",
  }, () => run.execute(body));

  assert.equal(run.calls.enrichment, 1);
  assert.equal(
    run.replay.calls.gets[0].analysisPolicyVersion,
    run.replay.calls.gets[1].analysisPolicyVersion
  );
});

test("HIT não renova expiry nem executa replay write", async () => {
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const replay = memoryRepository({
    get(key) { return hitFor(key, { statusCode: 200, body: { cached: true } }, { expiresAt }); },
  });
  const run = fixture({ replay, shadow: true });
  await run.execute();
  assert.equal(replay.calls.puts.length, 0);
  assert.equal((await replay.repository.get(replay.calls.gets[0])).value.expiresAt, expiresAt);
});

test("100 retries idênticos após o primeiro resultado geram zero chamadas adicionais", async () => {
  const run = fixture({ shadow: true });
  await run.execute();
  for (let index = 0; index < 100; index += 1) await run.execute();
  assert.equal(run.calls.enrichment, 1);
  assert.equal(run.calls.imei, 1);
  assert.equal(run.calls.decisionGet, 1);
  assert.equal(run.replay.calls.gets.length, 101);
  assert.equal(run.replay.calls.puts.length, 1);
});
