const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadAnalyzeForCharacterization,
  loadHealthForCharacterization,
  withIsolatedEnvironmentAsync: withIsolatedEnvironmentAsyncBase,
  withMutedConsoleAsync,
} = require("../helpers/analyze-characterization-harness.cjs");

const TEST_API_KEY = "synthetic-server-to-server-key";
const VALID_BODY = Object.freeze({
  cpf: "00000000000",
  nome: "Pessoa Sintética",
  email: "security-test@example.invalid",
  telefone_contato: "00000000000",
  cep: "00000000",
  valor_celular: 0,
  imeiCode: null,
  modelo_declarado: null,
  sessionId: "session-test",
  proposalId: "proposal-test",
  partnerCode: "partner-test",
  salesChannel: "api-test",
  device: {
    ip: "192.0.2.1",
    visitorId: "visitor-test",
    os: "TestOS",
    isMobile: true,
    fingerprintProvider: "synthetic",
  },
});

function withIsolatedEnvironmentAsync(overrides, callback) {
  return withIsolatedEnvironmentAsyncBase({ ANTIFRAUD_API_KEY: TEST_API_KEY, ...overrides }, callback);
}

function authorizedPost(body = VALID_BODY, authorization = `Bearer ${TEST_API_KEY}`) {
  return { method: "POST", headers: { authorization }, body };
}

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

function assertNoProcessing(calls) {
  assert.equal(calls.persistenceFactory.length, 0);
  assert.equal(calls.useCaseConstruct.length, 0);
  assert.equal(calls.useCaseExecute.length, 0);
  assert.equal(calls.enrichment.length, 0);
  assert.equal(calls.imei.length, 0);
  assert.equal(calls.cacheGet.length, 0);
  assert.equal(calls.cacheSet.length, 0);
  assert.equal(calls.decisionLog.length, 0);
  assert.equal(calls.enrichmentRaw.length, 0);
  assert.equal(calls.imeiRaw.length, 0);
}

test("composition root rejeita método diferente de POST com 405", async () => {
  const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
  const res = response();
  await loaded.exports.default({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, "Method not allowed");
  assert.equal(res.headers.allow, "POST");
  assert.equal(loaded.calls.persistenceFactory.length, 0);
  assert.equal(loaded.calls.useCaseConstruct.length, 0);
  assert.equal(loaded.calls.useCaseExecute.length, 0);
});

test("POST válido delega body e trace ao use case", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default(authorizedPost(), res);
    assert.equal(loaded.calls.useCaseExecute.length, 1);
    assert.deepEqual(loaded.calls.useCaseExecute[0].body, VALID_BODY);
    assert.equal(typeof loaded.calls.useCaseExecute[0].traceId, "string");
    assert.equal(typeof loaded.calls.useCaseExecute[0].startedAtMs, "number");
  });
});

test("status retornado pelo use case é respeitado", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 400, body: { ok: false, error: "Missing cpf" } },
    });
    const res = response();
    await loaded.exports.default(authorizedPost(), res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { ok: false, error: "Missing cpf" });
  });
});

test("exception fatal do use case preserva resposta HTTP 500", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseError: new Error("fatal-test"),
    });
    const res = response();
    await withMutedConsoleAsync(() => loaded.exports.default(authorizedPost(), res));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, "FUNCTION_INVOCATION_FAILED");
    assert.equal("details" in res.body, false);
  });
});

test("X-Request-Id identifica cada request HTTP sem substituir traceId reutilizado no body", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const replayTraceId = "original-analysis-trace";
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true, traceId: replayTraceId } },
    });
    const first = response();
    const second = response();

    await loaded.exports.default(authorizedPost(), first);
    await loaded.exports.default(authorizedPost(), second);

    assert.match(first.headers["x-request-id"], /^[0-9a-f-]{36}$/i);
    assert.match(second.headers["x-request-id"], /^[0-9a-f-]{36}$/i);
    assert.notEqual(first.headers["x-request-id"], second.headers["x-request-id"]);
    assert.equal(first.body.traceId, replayTraceId);
    assert.equal(second.body.traceId, replayTraceId);
  });
});

test("respostas de erro não ecoam Authorization, API key ou body", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const secret = TEST_API_KEY;
    const rawImei = "490154203237518";
    const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
    const unauthorized = response();
    await loaded.exports.default(authorizedPost({ ...VALID_BODY, imeiCode: rawImei }, "Bearer wrong-key"), unauthorized);

    const serializedUnauthorized = JSON.stringify(unauthorized.body);
    assert.equal(serializedUnauthorized.includes("wrong-key"), false);
    assert.equal(serializedUnauthorized.includes(secret), false);
    assert.equal(serializedUnauthorized.includes(rawImei), false);

    const invalid = response();
    await loaded.exports.default(authorizedPost({ ...VALID_BODY, imeiCode: rawImei, unexpected: secret }), invalid);
    const serializedInvalid = JSON.stringify(invalid.body);
    assert.equal(serializedInvalid.includes(secret), false);
    assert.equal(serializedInvalid.includes(rawImei), false);
  });
});

test("Authorization ausente retorna 401 genérico antes de qualquer processamento", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
    const res = response();
    await loaded.exports.default({ method: "POST", headers: {}, body: VALID_BODY }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, "UNAUTHORIZED");
    assertNoProcessing(loaded.calls);
  });
});

test("Bearer incorreto retorna 401 antes de qualquer processamento", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
    const res = response();
    await loaded.exports.default(authorizedPost(VALID_BODY, "Bearer wrong-key"), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, "UNAUTHORIZED");
    assertNoProcessing(loaded.calls);
  });
});

for (const authorization of ["Basic abc", "Bearer", "Bearer token with spaces", ["Bearer duplicated"]]) {
  test(`Authorization malformado é rejeitado (${JSON.stringify(authorization)})`, async () => {
    await withIsolatedEnvironmentAsync({}, async () => {
      const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
      const res = response();
      await loaded.exports.default({ method: "POST", headers: { authorization }, body: VALID_BODY }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, "UNAUTHORIZED");
      assertNoProcessing(loaded.calls);
    });
  });
}

test("ANTIFRAUD_API_KEY ausente falha fechado com 503", async () => {
  await withIsolatedEnvironmentAsyncBase({}, async () => {
    const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
    const res = response();
    await withMutedConsoleAsync(() => loaded.exports.default(
      { method: "POST", headers: { authorization: "Bearer any-value" }, body: VALID_BODY },
      res
    ));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "SERVICE_UNAVAILABLE");
    assertNoProcessing(loaded.calls);
  });
});

test("health continua público e preserva contrato mínimo", () => {
  const health = loadHealthForCharacterization();
  const res = response();
  health.default({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.service, "antifraude-engine");
  assert.equal(typeof res.body.timestamp, "string");
  assert.deepEqual(Object.keys(res.body).sort(), ["service", "status", "timestamp"]);
});

for (const [label, invalidBody] of [
  ["null", null],
  ["array", []],
  ["string", "invalid"],
  ["number", 1],
  ["boolean", true],
]) {
  test(`body ${label} retorna 400 sem processamento`, async () => {
    await withIsolatedEnvironmentAsync({}, async () => {
      const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
      const res = response();
      await loaded.exports.default(authorizedPost(invalidBody), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, "INVALID_REQUEST");
      assertNoProcessing(loaded.calls);
    });
  });
}

for (const [label, body] of [
  ["campo com tipo incorreto", { ...VALID_BODY, nome: { unexpected: true } }],
  ["campo desconhecido", { ...VALID_BODY, typo_field: "x" }],
  ["device com campo desconhecido", { ...VALID_BODY, device: { extra: "x" } }],
  ["valor_celular string", { ...VALID_BODY, valor_celular: "100" }],
  ["valor_celular negativo", { ...VALID_BODY, valor_celular: -1 }],
  ["valor_celular NaN", { ...VALID_BODY, valor_celular: Number.NaN }],
  ["valor_celular Infinity", { ...VALID_BODY, valor_celular: Number.POSITIVE_INFINITY }],
  ["valor_celular -Infinity", { ...VALID_BODY, valor_celular: Number.NEGATIVE_INFINITY }],
  ["string acima do limite", { ...VALID_BODY, nome: "x".repeat(201) }],
]) {
  test(`${label} retorna 400 sem processamento`, async () => {
    await withIsolatedEnvironmentAsync({}, async () => {
      const loaded = loadAnalyzeForCharacterization({ mockUseCase: true });
      const res = response();
      await loaded.exports.default(authorizedPost(body), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, "INVALID_REQUEST");
      assertNoProcessing(loaded.calls);
    });
  });
}

test("campos opcionais null e valor finito não negativo continuam válidos", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const body = {
      cpf: "00000000000",
      cep: null, nome: null, email: null, device: null, imeiCode: null,
      sessionId: null, proposalId: null, partnerCode: null, salesChannel: null,
      valor_celular: 123.45, modelo_declarado: null, telefone_contato: null,
    };
    const res = response();
    await loaded.exports.default(authorizedPost(body), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(loaded.calls.useCaseExecute[0].body, body);
  });
});

test("CPF formatado é normalizado sem introduzir validação de checksum", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default(authorizedPost({ cpf: "111.111.111-11" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(loaded.calls.useCaseExecute[0].body.cpf, "11111111111");
  });
});

test("IMEI estruturalmente string continua no domínio para IMEI_INVALID", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    const loaded = loadAnalyzeForCharacterization({
      mockUseCase: true,
      useCaseResult: { statusCode: 200, body: { ok: true } },
    });
    const res = response();
    await loaded.exports.default(authorizedPost({ cpf: "00000000000", imeiCode: "123" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(loaded.calls.useCaseExecute[0].body.imeiCode, "123");
  });
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
      await loaded.exports.default(authorizedPost(), res);
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
    await loaded.exports.default(authorizedPost(), res);
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
    await loaded.exports.default(authorizedPost(), res);
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
    await loaded.exports.default(authorizedPost(), res);
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
    await loaded.exports.default(authorizedPost(), res);
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
    await loaded.exports.default(authorizedPost(), res);
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
    await loaded.exports.default(authorizedPost(), res);
    const dependencies = loaded.calls.useCaseConstruct[0];
    assert.equal(dependencies.imeiBlacklistProvider.service, "blacklist:777");
    assert.equal(dependencies.cacheV2ImeiRead, undefined);
    assert.equal(dependencies.cacheV2ImeiBlacklistRead.service, "blacklist:777");
    assert.equal(dependencies.cacheV2ImeiBlacklistRead.providerContractVersion, "imei-info-blacklist-v1");
    assert.equal(dependencies.cacheV2ImeiBlacklistRead.normalizerVersion, "imei-blacklist-normalizer-v2");
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
    await loaded.exports.default(authorizedPost(), res);
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
    await withMutedConsoleAsync(() => loaded.exports.default(authorizedPost(), res));
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
    await loaded.exports.default(authorizedPost(), res);
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
    await withMutedConsoleAsync(() => loaded.exports.default(authorizedPost(), res));
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
    await withMutedConsoleAsync(() => loaded.exports.default(authorizedPost(), res));
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
    await withMutedConsoleAsync(() => loaded.exports.default(authorizedPost(), res));
    assert.equal(res.statusCode, 500);
    assert.equal(loaded.calls.useCaseConstruct.length, 0);
  });
});
