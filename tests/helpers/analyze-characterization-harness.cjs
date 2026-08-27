const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const ANALYZE_PATH = path.resolve(__dirname, "../../api/analyze.ts");

const ISOLATED_ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_MISSING_POLICY",
  "ENRICHMENT_MODE",
  "ENRICHMENT_TIMEOUT_MS",
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
  "CACHE_TTL_DAYS_APPROVE",
  "CACHE_TTL_DAYS_APROVE",
  "CACHE_TTL_DAYS_DECLINE",
  "CACHE_TTL_SECONDS_ON_TECH_FAIL",
];

function transpileAnalyzeForCharacterization() {
  const source = fs.readFileSync(ANALYZE_PATH, "utf8");
  const instrumentedSource = `${source}\nexport const __characterization = {\n  detectHardBlock,\n  computeScoreLocal,\n  classifyProfileByScore,\n  computeTelemetryFlags,\n};\n`;

  return ts.transpileModule(instrumentedSource, {
    fileName: ANALYZE_PATH,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
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
  };

  const enrichmentModule = {
    normalizeInput: normalizeProviderInput,
    enrich: async (input) => {
      calls.enrichment.push(input);
      if (typeof options.enrichmentResult === "function") {
        return options.enrichmentResult(input);
      }
      return options.enrichmentResult;
    },
  };

  const imeiModule = {
    imeiCheckReal: async (input) => {
      calls.imei.push(input);
      if (typeof options.imeiResult === "function") {
        return options.imeiResult(input);
      }
      if (!options.imeiResult) {
        throw new Error("UNEXPECTED_IMEI_CALL");
      }
      return options.imeiResult;
    },
  };

  const supabaseModule = {
    createClient: (...args) => {
      calls.supabase.push(args);
      throw new Error("UNEXPECTED_SUPABASE_CALL");
    },
  };

  const compiledModule = new Module(ANALYZE_PATH, module);
  compiledModule.filename = ANALYZE_PATH;
  compiledModule.paths = Module._nodeModulePaths(path.dirname(ANALYZE_PATH));

  const defaultRequire = compiledModule.require.bind(compiledModule);
  compiledModule.require = (request) => {
    if (request === "@supabase/supabase-js") return supabaseModule;
    if (request === "../src/providers/enrichment") return enrichmentModule;
    if (request === "../src/providers/imei") return imeiModule;
    return defaultRequire(request);
  };

  const originalTypeScriptLoader = Module._extensions[".ts"];
  Module._extensions[".ts"] = (loadedModule, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    loadedModule._compile(output, filename);
  };

  try {
    compiledModule._compile(transpileAnalyzeForCharacterization(), ANALYZE_PATH);
  } finally {
    if (originalTypeScriptLoader) {
      Module._extensions[".ts"] = originalTypeScriptLoader;
    } else {
      delete Module._extensions[".ts"];
    }
  }
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

async function invokeAnalyze({ input, enrichmentResult, imeiResult, env = {} }) {
  const restoreEnvironment = isolateEnvironment({
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
    const loaded = loadAnalyzeForCharacterization({ enrichmentResult, imeiResult });
    const response = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return body;
      },
    };

    await loaded.exports.default({ method: "POST", body: input }, response);

    return {
      statusCode: response.statusCode,
      body: response.body,
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
  loadAnalyzeForCharacterization,
  projectDecision,
  withIsolatedEnvironment,
  withMutedConsole,
};
