const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const ANALYZE_PATH = path.resolve(__dirname, "../../api/analyze.ts");
const HEALTH_PATH = path.resolve(__dirname, "../../api/health.ts");
const ACTIVE_ENGINE_PATH = path.resolve(
  __dirname,
  "../../src/domain/engine/index.ts"
);
const TECHTRAIL_PROVIDER_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/providers/techtrail/techTrailEnrichmentProvider.ts"
);
const IMEI_INFO_PROVIDER_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/providers/imeiInfo/imeiInfoProvider.ts"
);
const IMEI_BLACKLIST_PROVIDER_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/providers/imeiInfo/imeiBlacklistProvider.ts"
);
const IMEI_BLACKLIST_CORE_PATH = path.resolve(
  __dirname,
  "../../src/providers/imeiBlacklist.ts"
);
const SUPABASE_PERSISTENCE_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/persistence/supabase/supabasePersistence.ts"
);
const ANALYZE_USE_CASE_PATH = path.resolve(
  __dirname,
  "../../src/application/useCases/analyzeAntifraud.ts"
);
const CACHE_V2_ADAPTERS_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/persistence/supabase/cacheV2Adapters.ts"
);
const HMAC_LOOKUP_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/security/hmacLookupTokenService.ts"
);
const CACHE_V2_CONFIG_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/config/cacheV2Config.ts"
);
const ENV_PARSERS_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/config/envParsers.ts"
);
const DECISION_POLICY_PATH = path.resolve(
  __dirname,
  "../../src/application/cacheV2/decisionPolicy.ts"
);
const SCORE_CONFIG_PATH = path.resolve(
  __dirname,
  "../../src/domain/engine/scoreConfig.ts"
);

const ISOLATED_ENV_NAMES = [
  "SUPABASE_URL",
  "ANTIFRAUD_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_MISSING_POLICY",
  "ENRICHMENT_MODE",
  "ENRICHMENT_TIMEOUT_MS",
  "ENRICHMENT_MOCK_MS",
  "ENRICHMENT_URL_BASE",
  "ENRICHMENT_AUTH",
  "ENRICHMENT_FAIL_DECISION",
  "SCORE_EMAIL_DIVERGENTE",
  "SCORE_TELEFONE_DIVERGENTE",
  "SCORE_CEP_DIVERGENTE",
  "SCORE_RISCO_ALTISSIMO",
  "SCORE_RISCO_ALTO",
  "SCORE_RISCO_MEDIO",
  "SCORE_RISCO_BAIXO",
  "SCORE_RISCO_BAIXISSIMO",
  "SCORE_PROB_ALTISSIMA",
  "SCORE_PROB_ALTA",
  "SCORE_PROB_MEDIA",
  "SCORE_PROB_BAIXA",
  "SCORE_PROB_BAIXISSIMA",
  "SCORE_PROC_4_5",
  "SCORE_PROC_GT_5",
  "VALOR_CELULAR_HIGH_VALUE_MIN",
  "SCORE_VALOR_CELULAR_HIGH_VALUE",
  "IMEI_TIMEOUT_MS",
  "SCORE_IMEI_PROBLEM",
  "IMEI_INFO_API_KEY",
  "IMEI_INFO_SERVICE_ID_SAMSUNG",
  "IMEI_INFO_SERVICE_ID_APPLE",
  "IMEI_INFO_SERVICE_ID_XIAOMI",
  "IMEI_BLACKLIST_V1_ENABLED",
  "IMEI_BLACKLIST_SERVICE_ID",
  "CACHE_TTL_DAYS_APPROVE",
  "CACHE_TTL_DAYS_APROVE",
  "CACHE_TTL_DAYS_DECLINE",
  "CACHE_TTL_SECONDS_ON_TECH_FAIL",
  "EVIDENCE_LOOKUP_HMAC_KEY",
  "ANALYSIS_REPLAY_ENABLED",
  "CACHE_V2_WRITE_ENABLED",
  "CACHE_V2_READ_TECHTRAIL_ENABLED",
  "CACHE_V2_READ_IMEI_ENABLED",
  "DECISION_CACHE_V1_READ_ENABLED",
  "TECHTRAIL_CACHE_TTL_DAYS",
  "IMEI_CACHE_TTL_DAYS",
  "ANALYSIS_REPLAY_TTL_DAYS",
];

function transpileAnalyzeForCharacterization() {
  const source = fs.readFileSync(ANALYZE_PATH, "utf8");
  return transpileTypeScript(source, ANALYZE_PATH);
}

function transpileTypeScript(source, fileName) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
}

function withTypeScriptLoader(callback) {
  const originalTypeScriptLoader = Module._extensions[".ts"];
  Module._extensions[".ts"] = (loadedModule, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    loadedModule._compile(transpileTypeScript(source, filename), filename);
  };

  try {
    return callback();
  } finally {
    if (originalTypeScriptLoader) {
      Module._extensions[".ts"] = originalTypeScriptLoader;
    } else {
      delete Module._extensions[".ts"];
    }
  }
}

function loadActiveEngineForCharacterization() {
  return withTypeScriptLoader(() => require(ACTIVE_ENGINE_PATH));
}

function loadProviderAdaptersForCharacterization() {
  return withTypeScriptLoader(() => ({
    enrichment: require(TECHTRAIL_PROVIDER_PATH),
    imei: require(IMEI_INFO_PROVIDER_PATH),
    imeiBlacklist: require(IMEI_BLACKLIST_PROVIDER_PATH),
    imeiBlacklistCore: require(IMEI_BLACKLIST_CORE_PATH),
  }));
}

function loadSupabasePersistenceForCharacterization() {
  return withTypeScriptLoader(() => require(SUPABASE_PERSISTENCE_PATH));
}

function loadAnalyzeUseCaseForCharacterization() {
  return withTypeScriptLoader(() => require(ANALYZE_USE_CASE_PATH));
}

function loadHealthForCharacterization() {
  return withTypeScriptLoader(() => require(HEALTH_PATH));
}

function loadCacheV2FoundationForCharacterization() {
  return withTypeScriptLoader(() => ({
    adapters: require(CACHE_V2_ADAPTERS_PATH),
    hmac: require(HMAC_LOOKUP_PATH),
    config: require(CACHE_V2_CONFIG_PATH),
    envParsers: require(ENV_PARSERS_PATH),
    decisionPolicy: require(DECISION_POLICY_PATH),
    scoreConfig: require(SCORE_CONFIG_PATH),
  }));
}

function normalizeProviderInput(body) {
  return {
    ...body,
    traceId: String(body?.traceId ?? ""),
    cpf: String(body?.cpf ?? "").replace(/\D/g, ""),
  };
}

function loadAnalyzeForCharacterization(options = {}) {
  const calls = {
    enrichment: [],
    imei: [],
    supabase: [],
    cacheGet: [],
    cacheSet: [],
    decisionLog: [],
    enrichmentRaw: [],
    imeiRaw: [],
    persistenceFactory: [],
    useCaseConstruct: [],
    useCaseExecute: [],
    useCaseResults: [],
  };

  const enrichmentAdapterModule = {
    normalizeEnrichmentInput: normalizeProviderInput,
    techTrailEnrichmentProvider: {
      enrich: async (input) => {
        calls.enrichment.push(input);
        if (typeof options.enrichmentResult === "function") {
          return options.enrichmentResult(input);
        }
        return options.enrichmentResult;
      },
    },
  };

  const imeiAdapterModule = {
    imeiInfoProvider: {
      check: async (input) => {
        calls.imei.push(input);
        if (typeof options.imeiResult === "function") {
          return options.imeiResult(input);
        }
        if (!options.imeiResult) {
          throw new Error("UNEXPECTED_IMEI_CALL");
        }
        return options.imeiResult;
      },
    },
  };

  const supabaseModule = {
    createClient: (...args) => {
      calls.supabase.push(args);
      throw new Error("UNEXPECTED_SUPABASE_CALL");
    },
  };

  const persistence = options.persistence === null
    ? null
    : options.persistence?.instance ?? {
        decisionCache: {
          get: async (cpf) => {
            calls.cacheGet.push(cpf);
            if (options.persistence?.cacheGetError) throw options.persistence.cacheGetError;
            return options.persistence?.cacheHit ?? null;
          },
          set: async (entry) => {
            calls.cacheSet.push(entry);
            if (options.persistence?.cacheSetError) throw options.persistence.cacheSetError;
            return options.persistence?.cacheSetResult ?? new Date(Date.now() + 1000).toISOString();
          },
        },
        decisionAuditRepository: {
          saveDecision: async (row) => {
            calls.decisionLog.push(row);
            if (options.persistence?.decisionLogError) throw options.persistence.decisionLogError;
          },
        },
        providerRawRepository: {
          saveEnrichment: async (row) => {
            calls.enrichmentRaw.push(row);
            if (options.persistence?.enrichmentRawError) throw options.persistence.enrichmentRawError;
          },
          saveImei: async (row) => {
            calls.imeiRaw.push(row);
            if (options.persistence?.imeiRawError) throw options.persistence.imeiRawError;
          },
        },
      };

  const persistenceModule = {
    createSupabasePersistenceOrNull: () => {
      calls.persistenceFactory.push(true);
      return options.persistence === undefined ? null : persistence;
    },
  };

  const useCaseModule = options.mockUseCase
    ? {
        AnalyzeAntifraudUseCase: class {
          constructor(dependencies) {
            calls.useCaseConstruct.push(dependencies);
          }
          async execute(command) {
            calls.useCaseExecute.push(command);
            if (options.useCaseError) throw options.useCaseError;
            const result = options.useCaseResult;
            if (result?.statusCode >= 200 && result?.statusCode < 300 && result?.body?.ok === true) {
              return {
                ...result,
                body: {
                  traceId: command.traceId,
                  decision: "APPROVE",
                  score: 0,
                  reasons: [],
                  ruleVersion: "score-v1",
                  ...result.body,
                },
              };
            }
            return result;
          }
        },
      }
    : null;

  const compiledModule = new Module(ANALYZE_PATH, module);
  compiledModule.filename = ANALYZE_PATH;
  compiledModule.paths = Module._nodeModulePaths(path.dirname(ANALYZE_PATH));

  const defaultRequire = compiledModule.require.bind(compiledModule);
  compiledModule.require = (request) => {
    if (request === "@supabase/supabase-js") return supabaseModule;
    if (
      request === "../src/application/useCases/analyzeAntifraud" &&
      useCaseModule
    ) {
      return useCaseModule;
    }
    if (
      request === "../src/application/useCases/analyzeAntifraud" &&
      options.captureUseCaseResult
    ) {
      const actualUseCaseModule = defaultRequire(request);
      return {
        ...actualUseCaseModule,
        AnalyzeAntifraudUseCase: class extends actualUseCaseModule.AnalyzeAntifraudUseCase {
          async execute(command) {
            const result = await super.execute(command);
            calls.useCaseResults.push(result);
            return result;
          }
        },
      };
    }
    if (
      request ===
      "../src/infrastructure/persistence/supabase/supabasePersistence" &&
      !options.useRealAdapters
    ) {
      return persistenceModule;
    }
    if (
      request ===
      "../src/infrastructure/providers/techtrail/techTrailEnrichmentProvider" &&
      !options.useRealAdapters
    ) {
      return enrichmentAdapterModule;
    }
    if (
      request ===
      "../src/infrastructure/providers/imeiInfo/imeiInfoProvider" &&
      !options.useRealAdapters
    ) {
      return imeiAdapterModule;
    }
    return defaultRequire(request);
  };

  withTypeScriptLoader(() => {
    compiledModule._compile(transpileAnalyzeForCharacterization(), ANALYZE_PATH);
  });
  return { exports: compiledModule.exports, calls };
}

function isolateEnvironment(overrides = {}) {
  const previous = new Map();

  for (const name of ISOLATED_ENV_NAMES) {
    previous.set(name, {
      existed: Object.prototype.hasOwnProperty.call(process.env, name),
      value: process.env[name],
    });
    delete process.env[name];
  }

  for (const [name, value] of Object.entries(overrides)) {
    process.env[name] = String(value);
  }

  return () => {
    for (const [name, saved] of previous) {
      if (saved.existed) process.env[name] = saved.value;
      else delete process.env[name];
    }
  };
}

function withIsolatedEnvironment(overrides, callback) {
  const restore = isolateEnvironment(overrides);
  try {
    return callback();
  } finally {
    restore();
  }
}

async function withIsolatedEnvironmentAsync(overrides, callback) {
  const restore = isolateEnvironment(overrides);
  try {
    return await callback();
  } finally {
    restore();
  }
}

function withMutedConsole(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return callback();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function withMutedConsoleAsync(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function invokeAnalyze({ input, enrichmentResult, imeiResult, persistence, env = {} }) {
  const restoreEnvironment = isolateEnvironment({
    ANTIFRAUD_API_KEY: "synthetic-characterization-api-key",
    SUPABASE_MISSING_POLICY: "continue",
    ENRICHMENT_MODE: "mock",
    ENRICHMENT_TIMEOUT_MS: "25",
    ...env,
  });

  const originalFetch = global.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  let networkCalls = 0;

  global.fetch = async () => {
    networkCalls += 1;
    throw new Error("NETWORK_CALL_BLOCKED_BY_CHARACTERIZATION_TEST");
  };
  console.log = () => {};
  console.error = () => {};

  try {
    const loaded = loadAnalyzeForCharacterization({
      enrichmentResult,
      imeiResult,
      persistence,
      captureUseCaseResult: true,
    });
    const response = {
      statusCode: null,
      body: null,
      headers: {},
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return body;
      },
    };

    await loaded.exports.default({
      method: "POST",
      headers: { authorization: "Bearer synthetic-characterization-api-key" },
      body: input,
    }, response);

    return {
      statusCode: response.statusCode,
      body: response.body,
      internalBody: loaded.calls.useCaseResults[0]?.body,
      headers: response.headers,
      calls: loaded.calls,
      networkCalls,
    };
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    restoreEnvironment();
  }
}

function projectDecision(body) {
  const hardBlockEvent = body.events?.find((event) => event.step === "hard_block_check");
  const profileEvent = body.events?.find((event) => event.step === "decision_profiled");

  return {
    decision: body.decision,
    score: body.score,
    reasons: body.reasons,
    scoreBreakdown: body.scoreBreakdown,
    profile: profileEvent?.meta?.profile ?? null,
    hardBlock: hardBlockEvent
      ? {
          isHardBlock: hardBlockEvent.meta.isHardBlock,
          reasons: hardBlockEvent.meta.reasons,
        }
      : null,
  };
}

module.exports = {
  invokeAnalyze,
  loadActiveEngineForCharacterization,
  loadAnalyzeForCharacterization,
  loadAnalyzeUseCaseForCharacterization,
  loadCacheV2FoundationForCharacterization,
  loadHealthForCharacterization,
  loadProviderAdaptersForCharacterization,
  loadSupabasePersistenceForCharacterization,
  projectDecision,
  withIsolatedEnvironment,
  withIsolatedEnvironmentAsync,
  withMutedConsole,
  withMutedConsoleAsync,
};
