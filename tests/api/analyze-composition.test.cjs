const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadAnalyzeForCharacterization,
  withIsolatedEnvironmentAsync,
  withMutedConsoleAsync,
} = require("../helpers/analyze-characterization-harness.cjs");

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

test("composition root rejeita método diferente de POST com 405", async () => {
  const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
  const res = response();
  await loaded.exports.default({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, "Method not allowed");
  assert.equal(loaded.calls.useCaseConstruct.length, 0);
  assert.equal(loaded.calls.useCaseExecute.length, 0);
});

test("POST válido delega body e trace ao use case", async () => {
  const body = { cpf: "123" };
  const loaded = loadAnalyzeForCharacterization({
    mockUseCase: true,
    useCaseResult: { statusCode: 200, body: { ok: true } },
  });
  const res = response();
  await loaded.exports.default({ method: "POST", body }, res);
  assert.equal(loaded.calls.useCaseExecute.length, 1);
  assert.equal(loaded.calls.useCaseExecute[0].body, body);
  assert.equal(typeof loaded.calls.useCaseExecute[0].traceId, "string");
  assert.equal(typeof loaded.calls.useCaseExecute[0].startedAtMs, "number");
});

test("status retornado pelo use case é respeitado", async () => {
  const loaded = loadAnalyzeForCharacterization({
    mockUseCase: true,
    useCaseResult: { statusCode: 400, body: { ok: false, error: "Missing cpf" } },
  });
  const res = response();
  await loaded.exports.default({ method: "POST", body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "Missing cpf" });
});

test("exception fatal do use case preserva resposta HTTP 500", async () => {
  const loaded = loadAnalyzeForCharacterization({
    mockUseCase: true,
    useCaseError: new Error("fatal-test"),
  });
  const res = response();
  await withMutedConsoleAsync(() => loaded.exports.default({ method: "POST", body: {} }, res));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "FUNCTION_INVOCATION_FAILED");
  assert.equal(res.body.details, "fatal-test");
});

test("composition root injeta adapters concretos sem rede real", async () => {
  await withIsolatedEnvironmentAsync({
    SUPABASE_URL: "https://composition.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-key",
  }, async () => {
    let networkCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { networkCalls += 1; throw new Error("network"); };
    try {
      const loaded = loadAnalyzeForCharacterization({
        mockUseCase: true,
        useRealAdapters: true,
        useCaseResult: { statusCode: 200, body: { ok: true } },
      });
      const res = response();
      await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
      const dependencies = loaded.calls.useCaseConstruct[0];
      assert.equal(typeof dependencies.enrichmentProvider.enrich, "function");
      assert.equal(typeof dependencies.imeiProvider.check, "function");
      assert.equal(typeof dependencies.decisionCache.get, "function");
      assert.equal(typeof dependencies.decisionAuditRepository.saveDecision, "function");
      assert.equal(typeof dependencies.providerRawRepository.saveEnrichment, "function");
      assert.equal(networkCalls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test("CACHE_V2_WRITE_ENABLED=false não injeta shadow", async () => {
  await withIsolatedEnvironmentAsync({ CACHE_V2_WRITE_ENABLED: "false" }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
    assert.equal(loaded.calls.useCaseConstruct[0].cacheV2Shadow, undefined);
    assert.equal(loaded.calls.useCaseConstruct[0].cacheV2TechTrailRead, undefined);
    assert.equal(loaded.calls.useCaseConstruct[0].cacheV2ImeiRead, undefined);
    assert.equal(loaded.calls.useCaseConstruct[0].cacheV2ReplayRead, undefined);
  });
});

test("ANALYSIS_REPLAY_ENABLED compõe somente o Replay Read", async () => {
  await withIsolatedEnvironmentAsync({
    ANALYSIS_REPLAY_ENABLED: "true",
    CACHE_V2_WRITE_ENABLED: "false",
    CACHE_V2_READ_TECHTRAIL_ENABLED: "false",
    CACHE_V2_READ_IMEI_ENABLED: "false",
    EVIDENCE_LOOKUP_HMAC_KEY: "synthetic-composition-key",
    SUPABASE_URL: "https://composition.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-key",
  }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
    const dependencies = loaded.calls.useCaseConstruct[0];
    assert.equal(dependencies.cacheV2Shadow, undefined);
    assert.equal(dependencies.cacheV2TechTrailRead, undefined);
    assert.equal(dependencies.cacheV2ImeiRead, undefined);
    assert.equal(typeof dependencies.cacheV2ReplayRead.analysisReplayRepository.get, "function");
    assert.equal(typeof dependencies.cacheV2ReplayRead.lookupTokenService.hashRelevantInput, "function");
    assert.equal(dependencies.cacheV2ReplayRead.cacheSchemaVersion, "cache-v2-schema-v1");
  });
});

test("CACHE_V2_READ_IMEI_ENABLED compõe somente leitura IMEI", async () => {
  await withIsolatedEnvironmentAsync({
    CACHE_V2_READ_IMEI_ENABLED: "true",
    CACHE_V2_WRITE_ENABLED: "false",
    EVIDENCE_LOOKUP_HMAC_KEY: "synthetic-composition-key",
    SUPABASE_URL: "https://composition.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-key",
  }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
    const dependencies = loaded.calls.useCaseConstruct[0];
    assert.equal(dependencies.cacheV2Shadow, undefined);
    assert.equal(dependencies.cacheV2TechTrailRead, undefined);
    assert.equal(typeof dependencies.cacheV2ImeiRead.imeiEvidenceCache.get, "function");
    assert.equal(typeof dependencies.cacheV2ImeiRead.lookupTokenService.tokenizeImei, "function");
    assert.equal(typeof dependencies.cacheV2ImeiRead.resolveContext, "function");
  });
});

test("CACHE_V2_READ_TECHTRAIL_ENABLED compõe somente leitura TechTrail", async () => {
  await withIsolatedEnvironmentAsync({
    CACHE_V2_READ_TECHTRAIL_ENABLED: "true",
    CACHE_V2_WRITE_ENABLED: "false",
    EVIDENCE_LOOKUP_HMAC_KEY: "synthetic-composition-key",
    SUPABASE_URL: "https://composition.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-key",
  }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
    const dependencies = loaded.calls.useCaseConstruct[0];
    assert.equal(dependencies.cacheV2Shadow, undefined);
    assert.equal(typeof dependencies.cacheV2TechTrailRead.enrichmentEvidenceCache.get, "function");
    assert.equal(typeof dependencies.cacheV2TechTrailRead.lookupTokenService.tokenizeCpf, "function");
  });
});

test("DECISION_CACHE_V1_READ_ENABLED é transportada explicitamente", async () => {
  await withIsolatedEnvironmentAsync({ DECISION_CACHE_V1_READ_ENABLED: "false" }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
    assert.equal(loaded.calls.useCaseExecute[0].config.decisionCacheV1ReadEnabled, false);
  });
});

test("IMEI_BLACKLIST_V1_ENABLED compõe provider e cache Blacklist versionado", async () => {
  await withIsolatedEnvironmentAsync({
    IMEI_BLACKLIST_V1_ENABLED: "true",
    IMEI_BLACKLIST_SERVICE_ID: "777",
    CACHE_V2_READ_IMEI_ENABLED: "true",
    EVIDENCE_LOOKUP_HMAC_KEY: "synthetic-composition-key",
    SUPABASE_URL: "https://composition.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-key",
  }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
    const dependencies = loaded.calls.useCaseConstruct[0];
    assert.equal(dependencies.imeiBlacklistProvider.service, "blacklist:777");
    assert.equal(dependencies.cacheV2ImeiRead, undefined);
    assert.equal(dependencies.cacheV2ImeiBlacklistRead.service, "blacklist:777");
    assert.equal(dependencies.cacheV2ImeiBlacklistRead.providerContractVersion, "imei-info-blacklist-v1");
    assert.equal(dependencies.cacheV2ImeiBlacklistRead.normalizerVersion, "imei-blacklist-normalizer-v1");
    assert.equal(loaded.calls.useCaseExecute[0].config.imeiBlacklistV1Enabled, true);
  });
});

test("service ID Blacklist ausente permanece indisponível sem default inventado", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_BLACKLIST_V1_ENABLED: "true" }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
    assert.equal(loaded.calls.useCaseConstruct[0].imeiBlacklistProvider.service, null);
    assert.equal(loaded.calls.useCaseExecute[0].config.imeiBlacklistV1Enabled, true);
  });
});

test("shadow habilitado sem HMAC não derruba composição V1", async () => {
  await withIsolatedEnvironmentAsync({ CACHE_V2_WRITE_ENABLED: "true" }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await withMutedConsoleAsync(() => loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res));
    assert.equal(res.statusCode, 200);
    assert.equal(loaded.calls.useCaseConstruct[0].cacheV2Shadow.lookupTokenService, null);
  });
});

test("validated ENRICHMENT_MODE keeps provider and TechTrail namespace coherent", async () => {
  await withIsolatedEnvironmentAsync({
    ENRICHMENT_MODE: " REAL ",
    CACHE_V2_READ_TECHTRAIL_ENABLED: "true",
    EVIDENCE_LOOKUP_HMAC_KEY: "synthetic-composition-key",
    SUPABASE_URL: "https://composition.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-key",
  }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res);
    assert.equal(loaded.calls.useCaseExecute[0].config.enrichmentMode, "real");
    assert.equal(loaded.calls.useCaseConstruct[0].cacheV2TechTrailRead.provider, "techtrail");
  });
});

test("invalid ENRICHMENT_MODE fails before composing use case or provider", async () => {
  await withIsolatedEnvironmentAsync({ ENRICHMENT_MODE: "reall" }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await withMutedConsoleAsync(() => loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, "FUNCTION_INVOCATION_FAILED");
    assert.equal(loaded.calls.useCaseConstruct.length, 0);
  });
});

test("invalid V2 flag fails before any provider is composed", async () => {
  await withIsolatedEnvironmentAsync({ CACHE_V2_WRITE_ENABLED: "tru" }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await withMutedConsoleAsync(() => loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, "FUNCTION_INVOCATION_FAILED");
    assert.equal(loaded.calls.useCaseConstruct.length, 0);
  });
});

test("invalid Blacklist flag fails before any provider is composed", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_BLACKLIST_V1_ENABLED: "tru" }, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await withMutedConsoleAsync(() => loaded.exports.default({ method: "POST", body: { cpf: "123" } }, res));
    assert.equal(res.statusCode, 500);
    assert.equal(loaded.calls.useCaseConstruct.length, 0);
  });
});
