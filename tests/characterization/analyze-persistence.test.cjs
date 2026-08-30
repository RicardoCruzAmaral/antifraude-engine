const test = require("node:test");
const assert = require("node:assert/strict");

const {
  invokeAnalyze,
  loadAnalyzeForCharacterization,
  loadSupabasePersistenceForCharacterization,
  withIsolatedEnvironmentAsync,
  withMutedConsole,
  withMutedConsoleAsync,
} = require("../helpers/analyze-characterization-harness.cjs");
const {
  SYNTHETIC_INPUT,
  enrichmentResult,
  enrichmentSummary,
  imeiResult,
} = require("../helpers/synthetic-fixtures.cjs");

const persistence = (overrides = {}) => overrides;

test("cache miss consulta somente pelo CPF e executa providers", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    persistence: persistence(),
  });
  assert.deepEqual(result.calls.cacheGet, [SYNTHETIC_INPUT.cpf.replace(/\D/g, "")]);
  assert.equal(result.calls.enrichment.length, 1);
  assert.equal(result.calls.cacheSet.length, 1);
});

test("entrada expirada é observada como miss e não pula enrichment", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    persistence: persistence({ cacheHit: null }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.internalBody.source, "engine");
  assert.equal(result.calls.enrichment.length, 1);
});

test("cache hit pula enrichment e IMEI e grava decision_log", async () => {
  const result = await invokeAnalyze({
    input: { ...SYNTHETIC_INPUT, imeiCode: "000000000000000" },
    enrichmentResult: () => { throw new Error("UNEXPECTED_ENRICHMENT"); },
    imeiResult: imeiResult("IMEI_OK"),
    persistence: persistence({
      cacheHit: {
        cpf: SYNTHETIC_INPUT.cpf,
        decision: "DECLINE",
        score: 55,
        reasons: ["CACHED"],
        ruleVersion: "cached-v1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.internalBody.source, "cache");
  assert.equal(result.body.ruleVersion, "cached-v1");
  assert.equal(result.calls.enrichment.length, 0);
  assert.equal(result.calls.imei.length, 0);
  assert.equal(result.calls.decisionLog.length, 1);
  assert.equal(result.calls.decisionLog[0].cacheHit, true);
});

test("APPROVE preserva TTL, ruleVersion e payload do cache", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    persistence: persistence(),
    env: { CACHE_TTL_DAYS_APPROVE: "17" },
  });
  assert.deepEqual(result.calls.cacheSet[0], {
    cpf: SYNTHETIC_INPUT.cpf.replace(/\D/g, ""),
    decision: "APPROVE",
    score: 0,
    reasons: ["RISCO_BAIXISSIMO", "PROB_ALTISSIMA"],
    ruleVersion: "score-v1",
    ttlKind: "days",
    ttlValue: 17,
    updatedAtIso: result.calls.cacheSet[0].updatedAtIso,
  });
});

test("typo CACHE_TTL_DAYS_APROVE continua suportado", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    persistence: persistence(),
    env: { CACHE_TTL_DAYS_APROVE: "19" },
  });
  assert.equal(result.calls.cacheSet[0].ttlValue, 19);
});

test("DECLINE preserva TTL próprio", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: enrichmentResult(enrichmentSummary({ motivos: ["NOME DIVERGENTE"] })),
    persistence: persistence(),
    env: { CACHE_TTL_DAYS_DECLINE: "23" },
  });
  assert.equal(result.calls.cacheSet[0].decision, "DECLINE");
  assert.equal(result.calls.cacheSet[0].ttlKind, "days");
  assert.equal(result.calls.cacheSet[0].ttlValue, 23);
});

test("falha técnica preserva TTL em segundos", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: { ok: false, provider: "mock", mode: "mock", error: { msg: "fail" } },
    persistence: persistence(),
    env: { CACHE_TTL_SECONDS_ON_TECH_FAIL: "41" },
  });
  assert.equal(result.calls.cacheSet[0].ttlKind, "seconds");
  assert.equal(result.calls.cacheSet[0].ttlValue, 41);
});

test("resultado engine grava decision_log completo", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    persistence: persistence(),
  });
  const log = result.calls.decisionLog[0];
  assert.equal(log.source, "engine");
  assert.equal(log.cacheHit, false);
  assert.equal(log.decision, result.internalBody.decision);
  assert.equal(log.ruleVersion, result.internalBody.ruleVersion);
  assert.deepEqual(log.inputSummary.cpf, SYNTHETIC_INPUT.cpf.replace(/\D/g, ""));
  assert.ok(Array.isArray(log.events));
  assert.ok(Array.isArray(result.internalBody.events));
  assert.equal(result.internalBody.source, "engine");
  assert.equal(result.internalBody.cpf, SYNTHETIC_INPUT.cpf.replace(/\D/g, ""));
  assert.deepEqual(
    Object.keys(result.body).sort(),
    ["decision", "ok", "reasons", "ruleVersion", "score", "traceId"]
  );
});

test("enrichment_raw recebe payload observado sem alterar decisão", async () => {
  const raw = { providerPayload: true };
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: { ...enrichmentResult(enrichmentSummary()), raw, requestParams: { cpf: "sent" } },
    persistence: persistence(),
  });
  assert.equal(result.body.decision, "APPROVE");
  assert.equal(result.calls.enrichmentRaw[0].responseJson, raw);
  assert.deepEqual(result.calls.enrichmentRaw[0].requestParams, { cpf: "sent" });
});

test("imei_raw recebe resultado e parâmetros sem alterar decisão", async () => {
  const result = await invokeAnalyze({
    input: { ...SYNTHETIC_INPUT, imeiCode: "000000000000000", modelo_declarado: "Apple" },
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    imeiResult: imeiResult("IMEI_OK"),
    persistence: persistence(),
  });
  assert.equal(result.body.decision, "APPROVE");
  assert.equal(result.calls.imeiRaw[0].imeiCode, "000000000000000");
  assert.equal(result.calls.imeiRaw[0].modeloDeclarado, "Apple");
  assert.equal(result.calls.imeiRaw[0].result.reason, "IMEI_OK");
});

test("SUPABASE_MISSING_POLICY=fail preserva resposta 500", async () => {
  await withIsolatedEnvironmentAsync({
    ANTIFRAUD_API_KEY: "synthetic-characterization-api-key",
    SUPABASE_MISSING_POLICY: "fail",
  }, async () => {
    const loaded = loadAnalyzeForCharacterization({ enrichmentResult: enrichmentResult(enrichmentSummary()) });
    const response = {
      statusCode: null,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; },
    };
    await withMutedConsoleAsync(() => loaded.exports.default({
      method: "POST",
      headers: { authorization: "Bearer synthetic-characterization-api-key" },
      body: SYNTHETIC_INPUT,
    }, response));
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error, "FUNCTION_INVOCATION_FAILED");
    assert.equal(loaded.calls.enrichment.length, 0);
  });
});

test("SUPABASE ausente com policy padrão continua", async () => {
  const result = await invokeAnalyze({
    input: SYNTHETIC_INPUT,
    enrichmentResult: enrichmentResult(enrichmentSummary()),
  });
  assert.equal(result.statusCode, 200);
  assert.ok(result.internalBody.events.some((event) => event.step === "supabase_missing_continue"));
});

function fakeSupabase(behavior = {}) {
  const calls = [];
  return {
    calls,
    client: {
      from(table) {
        const call = { table };
        calls.push(call);
        return {
          select(columns) { call.select = columns; return this; },
          eq(column, value) { call.eq = [column, value]; return this; },
          gt(column, value) { call.gt = [column, value]; return this; },
          async maybeSingle() {
            if (behavior.getThrows) throw behavior.getThrows;
            return behavior.getResult ?? { data: null, error: null };
          },
          async upsert(row, options) {
            call.row = row; call.options = options;
            if (behavior.upsertThrows) throw behavior.upsertThrows;
            return behavior.upsertResult ?? { error: null };
          },
          async insert(row) {
            call.row = row;
            if (behavior.insertThrows?.[table]) throw behavior.insertThrows[table];
            return behavior.insertResult?.[table] ?? { error: null };
          },
        };
      },
    },
  };
}

test("adapter consulta entrada não expirada por CPF", async () => {
  const fake = fakeSupabase();
  const { createSupabasePersistence } = loadSupabasePersistenceForCharacterization();
  const repository = createSupabasePersistence(fake.client);
  assert.equal(await repository.decisionCache.get("123"), null);
  assert.equal(fake.calls[0].table, "decision_cache");
  assert.deepEqual(fake.calls[0].eq, ["cpf", "123"]);
  assert.equal(fake.calls[0].gt[0], "expires_at");
  assert.ok(!Number.isNaN(Date.parse(fake.calls[0].gt[1])));
});

test("adapter trata erro de leitura como cache miss", async () => {
  const fake = fakeSupabase({ getResult: { data: null, error: new Error("read") } });
  const { createSupabasePersistence } = loadSupabasePersistenceForCharacterization();
  const repository = createSupabasePersistence(fake.client);
  await withMutedConsoleAsync(async () => assert.equal(await repository.decisionCache.get("123"), null));
});

test("adapter upsert usa onConflict cpf e falha de escrita é best-effort", async () => {
  const fake = fakeSupabase({ upsertResult: { error: new Error("write") } });
  const { createSupabasePersistence } = loadSupabasePersistenceForCharacterization();
  const repository = createSupabasePersistence(fake.client);
  const result = await withMutedConsoleAsync(() => repository.decisionCache.set({
    cpf: "123", decision: "APPROVE", score: 0, reasons: [], ruleVersion: "score-v1",
    ttlKind: "days", ttlValue: 30, updatedAtIso: "2026-01-01T00:00:00.000Z",
  }));
  assert.equal(result, null);
  assert.deepEqual(fake.calls[0].options, { onConflict: "cpf" });
  assert.equal(fake.calls[0].row.rule_version, "score-v1");
  assert.equal(fake.calls[0].row.updated_at, "2026-01-01T00:00:00.000Z");
});

test("falhas de decision_log e enrichment_raw permanecem best-effort", async () => {
  const fake = fakeSupabase({ insertResult: {
    decision_log: { error: new Error("log") },
    enrichment_raw: { error: new Error("raw") },
  } });
  const { createSupabasePersistence } = loadSupabasePersistenceForCharacterization();
  const repository = createSupabasePersistence(fake.client);
  await withMutedConsoleAsync(async () => {
    await repository.decisionAuditRepository.saveDecision({
      traceId: "t", cpf: "123", source: "engine", cacheHit: false, decision: "APPROVE",
      score: 0, reasons: [], ruleVersion: "v", inputSummary: null, events: [], latencyMs: 1,
    });
    await repository.providerRawRepository.saveEnrichment({
      traceId: "t", cpf: "123", provider: "p", ok: true, mode: "mock", httpStatus: 200,
      latencyMs: 1, requestParams: {}, responseJson: {}, error: null,
    });
  });
});

test("imei_raw ignora error retornado pelo SDK e captura exception", async () => {
  const { createSupabasePersistence } = loadSupabasePersistenceForCharacterization();
  const returnedError = fakeSupabase({ insertResult: { imei_raw: { error: new Error("sdk") } } });
  const thrownError = fakeSupabase({ insertThrows: { imei_raw: new Error("throw") } });
  const row = {
    traceId: "t", cpf: "123", imeiCode: "0", modeloDeclarado: "Apple",
    result: imeiResult("IMEI_OK"),
  };
  await createSupabasePersistence(returnedError.client).providerRawRepository.saveImei(row);
  await withMutedConsoleAsync(() => createSupabasePersistence(thrownError.client).providerRawRepository.saveImei(row));
  assert.equal(returnedError.calls[0].table, "imei_raw");
  assert.equal(thrownError.calls[0].table, "imei_raw");
});

test("adapter persiste raw Blacklist sem autoridade de modelo declarado", async () => {
  const fake = fakeSupabase();
  const { createSupabasePersistence } = loadSupabasePersistenceForCharacterization();
  await createSupabasePersistence(fake.client).providerRawRepository.saveImeiBlacklist({
    traceId: "blacklist-trace", cpf: "123", imeiCode: "490154203237518",
    result: {
      imei: "490154203237518", provider: "imei_info", service: "blacklist:777",
      status: "BLACKLISTED", model: "A", modelName: "Phone A", manufacturer: "Maker",
      blacklistStatusRaw: "Blacklisted", generalListStatus: "Yes", blacklistRecords: 1,
      deviceIsClean: false, providerCreatedAt: "2026-08-01T00:00:00Z",
      fetchedAt: "2026-08-28T00:00:00Z", rawReference: null,
      httpStatus: 200, latencyMs: 10, raw: { synthetic: true },
    },
  });
  const row = fake.calls[0].row;
  assert.equal(fake.calls[0].table, "imei_raw");
  assert.equal(row.service_id, 777);
  assert.equal(row.reason, "IMEI_BLACKLIST_BLACKLISTED");
  assert.equal(row.brand_expected, null);
  assert.deepEqual(row.request_params, { imeiCode: "490154203237518", policy: "BLACKLIST_V1" });
  assert.equal(Object.hasOwn(row.request_params, "modeloDeclarado"), false);
});

test("erros de cache, logs e raws no adapter não derrubam a request", async () => {
  const fake = fakeSupabase({
    getResult: { data: null, error: new Error("cache-read") },
    upsertResult: { error: new Error("cache-write") },
    insertResult: {
      decision_log: { error: new Error("decision-log") },
      enrichment_raw: { error: new Error("enrichment-raw") },
      imei_raw: { error: new Error("imei-sdk-return") },
    },
  });
  const { createSupabasePersistence } = loadSupabasePersistenceForCharacterization();
  const result = await withMutedConsoleAsync(() => invokeAnalyze({
    input: { ...SYNTHETIC_INPUT, imeiCode: "000000000000000" },
    enrichmentResult: enrichmentResult(enrichmentSummary()),
    imeiResult: imeiResult("IMEI_OK"),
    persistence: { instance: createSupabasePersistence(fake.client) },
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.decision, "APPROVE");
});
