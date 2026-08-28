const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadCacheV2FoundationForCharacterization,
  withIsolatedEnvironment,
} = require("../helpers/analyze-characterization-harness.cjs");

const foundation = loadCacheV2FoundationForCharacterization();

test("HMAC gera tokens determinísticos, distintos e sem identificador bruto", () => {
  const service = foundation.hmac.createHmacLookupTokenService("synthetic-secret");
  const cpf = "123.456.789-00";
  const imei = "490154203237518";
  assert.equal(service.tokenizeCpf(cpf), service.tokenizeCpf("12345678900"));
  assert.notEqual(service.tokenizeCpf(cpf), service.tokenizeCpf("12345678901"));
  assert.equal(service.tokenizeImei(imei), service.tokenizeImei(imei));
  assert.notEqual(service.tokenizeImei(imei), service.tokenizeImei("490154203237526"));
  assert.equal(service.tokenizeCpf(cpf).includes("12345678900"), false);
  assert.equal(service.tokenizeImei(imei).includes(imei), false);
});

test("input hash é canônico e payload diferente muda o hash", () => {
  const service = foundation.hmac.createHmacLookupTokenService("synthetic-secret");
  assert.equal(
    service.hashRelevantInput({ cpf: "1", nested: { b: 2, a: 1 } }),
    service.hashRelevantInput({ nested: { a: 1, b: 2 }, cpf: "1" })
  );
  assert.notEqual(
    service.hashRelevantInput({ cpf: "1", valor: 100 }),
    service.hashRelevantInput({ cpf: "1", valor: 101 })
  );
});

test("configuração V2 preserva defaults inativos e TTL TechTrail de 30 dias", () => {
  withIsolatedEnvironment({}, () => {
    assert.deepEqual(foundation.config.resolveCacheV2Config(), {
      analysisReplayEnabled: false,
      writeEnabled: false,
      readTechTrailEnabled: false,
      readImeiEnabled: false,
      decisionCacheV1ReadEnabled: true,
      techTrailTtlDays: 30,
      imeiTtlDays: null,
      replayTtlDays: null,
    });
  });
});

test("TTLs configuráveis preservam ausência de defaults IMEI/replay", () => {
  withIsolatedEnvironment({ TECHTRAIL_CACHE_TTL_DAYS: "12" }, () => {
    const config = foundation.config.resolveCacheV2Config();
    assert.equal(config.techTrailTtlDays, 12);
    assert.equal(config.imeiTtlDays, null);
    assert.equal(config.replayTtlDays, null);
    assert.equal(
      foundation.config.evidenceExpiresAt("2026-08-01T00:00:00.000Z", config.techTrailTtlDays),
      "2026-08-13T00:00:00.000Z"
    );
  });
});

test("TTLs IMEI e replay são lidos somente quando configurados", () => {
  withIsolatedEnvironment({ IMEI_CACHE_TTL_DAYS: "7", ANALYSIS_REPLAY_TTL_DAYS: "2" }, () => {
    const config = foundation.config.resolveCacheV2Config();
    assert.equal(config.imeiTtlDays, 7);
    assert.equal(config.replayTtlDays, 2);
  });
});

function fakeSupabase(results = {}) {
  const calls = [];
  return {
    calls,
    client: {
      from(table) {
        const call = { table, filters: [] };
        calls.push(call);
        return {
          select(columns) { call.select = columns; return this; },
          eq(column, value) { call.filters.push([column, value]); return this; },
          order(column, options) { call.order = [column, options]; return this; },
          limit(value) { call.limit = value; return this; },
          async maybeSingle() {
            const result = results[table];
            if (result instanceof Error) throw result;
            return result ?? { data: null, error: null };
          },
          async upsert(row, options) {
            call.row = row;
            call.options = options;
            return results[`${table}:upsert`] ?? { error: null };
          },
        };
      },
    },
  };
}

const evidenceKey = {
  lookupToken: "token",
  provider: "techtrail",
  providerContractVersion: "provider-v1",
  normalizerVersion: "normalizer-v1",
  cacheSchemaVersion: "cache-v1",
};

function evidenceRow(overrides = {}) {
  return {
    lookup_token: "token",
    provider: "techtrail",
    normalized_evidence: { risk: "LOW" },
    fetched_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    provider_contract_version: "provider-v1",
    normalizer_version: "normalizer-v1",
    cache_schema_version: "cache-v1",
    completeness: "COMPLETE",
    raw_reference: "raw-1",
    ...overrides,
  };
}

test("lookup V2 distingue HIT", async () => {
  const fake = fakeSupabase({ techtrail_evidence_cache: { data: evidenceRow(), error: null } });
  const cache = foundation.adapters.createSupabaseCacheV2Adapters(fake.client).enrichmentEvidenceCache;
  const result = await cache.get(evidenceKey);
  assert.equal(result.state, "HIT");
  assert.deepEqual(result.value.normalizedEvidence, { risk: "LOW" });
  assert.equal(result.value.rawReference, "raw-1");
});

test("lookup V2 distingue MISS", async () => {
  const fake = fakeSupabase();
  const result = await foundation.adapters.createSupabaseCacheV2Adapters(fake.client)
    .enrichmentEvidenceCache.get(evidenceKey);
  assert.deepEqual(result, { state: "MISS" });
});

test("lookup V2 distingue EXPIRED", async () => {
  const expiredAt = "2020-01-01T00:00:00.000Z";
  const fake = fakeSupabase({ techtrail_evidence_cache: { data: evidenceRow({ expires_at: expiredAt }), error: null } });
  const result = await foundation.adapters.createSupabaseCacheV2Adapters(fake.client)
    .enrichmentEvidenceCache.get(evidenceKey);
  assert.deepEqual(result, { state: "EXPIRED", expiredAt });
});

test("lookup V2 distingue INCOMPATIBLE", async () => {
  const fake = fakeSupabase({ techtrail_evidence_cache: {
    data: evidenceRow({ normalizer_version: "normalizer-old" }), error: null,
  } });
  const result = await foundation.adapters.createSupabaseCacheV2Adapters(fake.client)
    .enrichmentEvidenceCache.get(evidenceKey);
  assert.deepEqual(result, { state: "INCOMPATIBLE", reason: "NORMALIZER_VERSION" });
});

test("lookup V2 distingue BACKEND_ERROR", async () => {
  const fake = fakeSupabase({ techtrail_evidence_cache: { data: null, error: { code: "DB_DOWN" } } });
  const result = await foundation.adapters.createSupabaseCacheV2Adapters(fake.client)
    .enrichmentEvidenceCache.get(evidenceKey);
  assert.deepEqual(result, { state: "BACKEND_ERROR", errorCode: "DB_DOWN" });
});

test("adapter grava payload normalizado TechTrail com versões e sem raw completo", async () => {
  const fake = fakeSupabase();
  const cache = foundation.adapters.createSupabaseCacheV2Adapters(fake.client).enrichmentEvidenceCache;
  await cache.put({
    ...evidenceKey,
    normalizedEvidence: { risk: "LOW" },
    fetchedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-31T00:00:00.000Z",
    completeness: "COMPLETE",
    rawReference: "raw-techtrail-1",
  });
  const row = fake.calls[0].row;
  assert.equal(row.lookup_token, "token");
  assert.deepEqual(row.normalized_evidence, { risk: "LOW" });
  assert.equal(row.provider_contract_version, "provider-v1");
  assert.equal(row.normalizer_version, "normalizer-v1");
  assert.equal(row.cache_schema_version, "cache-v1");
  assert.equal(Object.hasOwn(row, "response_json"), false);
});

test("adapter grava payload normalizado IMEI com serviço e versões", async () => {
  const fake = fakeSupabase();
  const cache = foundation.adapters.createSupabaseCacheV2Adapters(fake.client).imeiEvidenceCache;
  await cache.put({
    lookupToken: "imei-token", provider: "imei_info", service: "service-1",
    normalizedEvidence: { reason: "IMEI_OK" },
    fetchedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-02T00:00:00.000Z",
    providerContractVersion: "provider-v1", normalizerVersion: "normalizer-v1",
    cacheSchemaVersion: "cache-v1", completeness: "COMPLETE", rawReference: "raw-imei-1",
  });
  assert.equal(fake.calls[0].row.service, "service-1");
  assert.deepEqual(fake.calls[0].row.normalized_evidence, { reason: "IMEI_OK" });
  assert.equal(fake.calls[0].row.raw_reference, "raw-imei-1");
});

test("adapter grava replay com proposal, input hash e ruleVersion", async () => {
  const fake = fakeSupabase();
  const repository = foundation.adapters.createSupabaseCacheV2Adapters(fake.client).analysisReplayRepository;
  await repository.put({
    proposalId: "proposal-1", inputHash: "input-hash", ruleVersion: "score-v1",
    cacheSchemaVersion: "cache-v1", result: { statusCode: 200, body: { decision: "APPROVE" } },
    createdAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-02T00:00:00.000Z",
  });
  assert.equal(fake.calls[0].row.proposal_id, "proposal-1");
  assert.equal(fake.calls[0].row.input_hash, "input-hash");
  assert.equal(fake.calls[0].row.rule_version, "score-v1");
  assert.deepEqual(fake.calls[0].row.result_json.body, { decision: "APPROVE" });
});
