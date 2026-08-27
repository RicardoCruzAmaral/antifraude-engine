const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadActiveEngineForCharacterization,
  withIsolatedEnvironment,
  withMutedConsole,
} = require("../helpers/analyze-characterization-harness.cjs");
const {
  SYNTHETIC_INPUT,
  enrichmentSummary,
  imeiResult,
} = require("../helpers/synthetic-fixtures.cjs");

const rules = loadActiveEngineForCharacterization();

function computeScore(summary, valor_celular = null, env = {}) {
  return withIsolatedEnvironment(env, () =>
    withMutedConsole(() =>
      rules.computeScoreLocal(
        { summary: { motivos: [], ...summary } },
        { valor_celular }
      )
    )
  );
}

function runPreEvaluation(summary, input = SYNTHETIC_INPUT, env = {}) {
  return withIsolatedEnvironment(env, () =>
    withMutedConsole(() =>
      rules.preEvaluate(
        { ok: true, summary: { motivos: [], ...summary } },
        input
      )
    )
  );
}

test("hard blocks textuais ativos são reconhecidos na ordem canônica", () => {
  const hardReasons = [
    "NOME DIVERGENTE",
    "CPF INVÁLIDO",
    "CPF COM SITUAÇÃO IRREGULAR",
    "CPF NÃO ENCONTRADO",
    "CPF CONSTA OBITO",
    "CPF SOCIO DE CNAE IMPEDIDO",
    "CONSTA MANDADO DE PRISAO",
    "CONSTAM 5 AÇÕES CIVEIS COMO AUTOR",
    "POSSUI ACAO CRIMINAL",
  ];

  const result = rules.detectHardBlock({
    summary: { motivos: [...hardReasons].reverse() },
  });

  assert.deepEqual(result, {
    isHardBlock: true,
    reasons: hardReasons,
  });
});

test("CPF sintético sem hard block e score baixo permanece livre de hard block", () => {
  assert.deepEqual(
    rules.detectHardBlock({
      summary: {
        motivos: ["MOCK_OK"],
        riscoCredito: "BAIXISSIMO",
        probabilidadePagamento: "ALTISSIMA",
      },
    }),
    { isHardBlock: false, reasons: [] }
  );
});

for (const probability of ["BAIXA", "BAIXISSIMA"]) {
  test(`hard block por ALTISSIMO + ${probability}`, () => {
    assert.deepEqual(
      rules.detectHardBlock({
        summary: {
          motivos: [],
          riscoCredito: "ALTISSIMO",
          probabilidadePagamento: probability,
        },
      }),
      { isHardBlock: true, reasons: ["HARD_BLOCK_RISCO_PROB"] }
    );
  });
}

test("divergências preservam pontos default e itens de breakdown, inclusive zero", () => {
  const cases = [
    ["EMAIL DIVERGENTE", "EMAIL_DIVERGENTE", 0],
    ["TELEFONE DIVERGENTE", "TELEFONE_DIVERGENTE", 0],
    ["CEP DIVERGENTE", "CEP_DIVERGENTE", 5],
  ];

  for (const [motivo, rule, points] of cases) {
    assert.deepEqual(computeScore({ motivos: [motivo] }), {
      score: points,
      breakdown: [{ rule, points }],
    });
  }
});

test("pesos configurados por ambiente são lidos no momento do cálculo", () => {
  assert.deepEqual(
    computeScore(
      { motivos: ["EMAIL DIVERGENTE", "TELEFONE DIVERGENTE"] },
      null,
      {
        SCORE_EMAIL_DIVERGENTE: 7,
        SCORE_TELEFONE_DIVERGENTE: 3,
      }
    ),
    {
      score: 10,
      breakdown: [
        { rule: "EMAIL_DIVERGENTE", points: 7 },
        { rule: "TELEFONE_DIVERGENTE", points: 3 },
      ],
    }
  );
});

test("todas as faixas atuais de riscoCredito", () => {
  const cases = [
    ["ALTISSIMO", 20],
    ["ALTO", 15],
    ["MEDIO", 5],
    ["BAIXO", 0],
    ["BAIXISSIMO", 0],
  ];

  for (const [value, points] of cases) {
    assert.deepEqual(computeScore({ riscoCredito: value }), {
      score: points,
      breakdown: [{ rule: `RISCO_${value}`, points }],
    });
  }
});

test("todas as faixas atuais de probabilidadePagamento", () => {
  const cases = [
    ["ALTISSIMA", 0],
    ["ALTA", 0],
    ["MEDIA", 5],
    ["BAIXA", 15],
    ["BAIXISSIMA", 20],
  ];

  for (const [value, points] of cases) {
    assert.deepEqual(computeScore({ probabilidadePagamento: value }), {
      score: points,
      breakdown: [{ rule: `PROB_${value}`, points }],
    });
  }
});

test("faixas atuais de quantidadeProcessos", () => {
  const cases = [
    [0, 0, []],
    [1, 0, []],
    [3, 0, []],
    [4, 20, [{ rule: "PROCESSOS_4_5", points: 20 }]],
    [5, 20, [{ rule: "PROCESSOS_4_5", points: 20 }]],
    [6, 25, [{ rule: "PROCESSOS_GT_5", points: 25 }]],
    [9, 25, [{ rule: "PROCESSOS_GT_5", points: 25 }]],
  ];

  for (const [value, score, breakdown] of cases) {
    assert.deepEqual(computeScore({ quantidadeProcessos: value }), {
      score,
      breakdown,
    });
  }
});

test("alto valor usa comparação estrita acima do limite", () => {
  assert.deepEqual(computeScore({}, 5000), { score: 0, breakdown: [] });
  assert.deepEqual(computeScore({}, 5001), {
    score: 5,
    breakdown: [{ rule: "VALOR_CELULAR_HIGH_VALUE", points: 5 }],
  });
});

test("limites exatos e um ponto acima de cada perfil", () => {
  const cases = [
    [0, "A"],
    [10, "A"],
    [11, "B1"],
    [25, "B1"],
    [26, "B2"],
    [45, "B2"],
    [46, "C"],
  ];

  for (const [score, expected] of cases) {
    assert.equal(rules.classifyProfileByScore(score), expected);
  }
});

test("pre-evaluation reúne hard block, score base, breakdown e telemetry flags", () => {
  const result = runPreEvaluation(
    {
      motivos: ["EMAIL DIVERGENTE"],
      riscoCredito: "MÉDIO",
      probabilidadePagamento: "ALTA",
      quantidadeProcessos: 4,
    },
    {
      ...SYNTHETIC_INPUT,
      device: { ...SYNTHETIC_INPUT.device, isMobile: false },
    }
  );

  assert.deepEqual(result, {
    hardBlock: { isHardBlock: false, reasons: [] },
    baseScore: 25,
    scoreBreakdown: [
      { rule: "EMAIL_DIVERGENTE", points: 0 },
      { rule: "RISCO_MEDIO", points: 5 },
      { rule: "PROB_ALTA", points: 0 },
      { rule: "PROCESSOS_4_5", points: 20 },
    ],
    telemetryFlags: {
      nonMobile: true,
      emailDivergente: true,
      telefoneDivergente: false,
      cepDivergente: false,
      riscoCredito: "MÉDIO",
      probabilidadePagamento: "ALTA",
      quantidadeProcessos: 4,
    },
  });
});

test("pre-evaluation de hard block mantém score null e não calcula flags", () => {
  assert.deepEqual(
    runPreEvaluation({ motivos: ["NOME DIVERGENTE"] }),
    {
      hardBlock: { isHardBlock: true, reasons: ["NOME DIVERGENTE"] },
      baseScore: null,
      scoreBreakdown: [],
      telemetryFlags: null,
    }
  );
});

test("final evaluation de hard block ignora resultado IMEI", () => {
  const preEvaluation = runPreEvaluation({
    motivos: ["NOME DIVERGENTE"],
  });

  assert.deepEqual(
    rules.finalizeEvaluation(
      preEvaluation,
      imeiResult("IMEI_INVALID"),
      99
    ),
    {
      hardBlock: { isHardBlock: true, reasons: ["NOME DIVERGENTE"] },
      score: null,
      scoreBreakdown: [],
      reasons: ["NOME DIVERGENTE"],
      profile: null,
      decision: "DECLINE",
    }
  );
});

test("final evaluation aplica somente os motivos IMEI atuais sem mutar a pré-avaliação", () => {
  const preEvaluation = runPreEvaluation({
    riscoCredito: "BAIXISSIMO",
    probabilidadePagamento: "ALTISSIMA",
  });
  const originalPreEvaluation = structuredClone(preEvaluation);
  const baseBreakdown = [
    { rule: "RISCO_BAIXISSIMO", points: 0 },
    { rule: "PROB_ALTISSIMA", points: 0 },
  ];

  for (const reason of [
    "IMEI_OK",
    "IMEI_INVALID",
    "IMEI_FAIL",
    "IMEI_BRAND_MISMATCH",
  ]) {
    const hasPenalty = reason !== "IMEI_OK";
    const result = rules.finalizeEvaluation(
      preEvaluation,
      imeiResult(reason),
      7
    );
    const expectedBreakdown = hasPenalty
      ? [...baseBreakdown, { rule: reason, points: 7 }]
      : baseBreakdown;

    assert.deepEqual(result, {
      hardBlock: { isHardBlock: false, reasons: [] },
      score: hasPenalty ? 7 : 0,
      scoreBreakdown: expectedBreakdown,
      reasons: expectedBreakdown.map((item) => item.rule),
      profile: "A",
      decision: "APPROVE",
    });
    assert.deepEqual(preEvaluation, originalPreEvaluation);
  }

  assert.deepEqual(
    rules.finalizeEvaluation(
      preEvaluation,
      imeiResult("IMEI_INVALID"),
      0
    ).scoreBreakdown,
    [...baseBreakdown, { rule: "IMEI_INVALID", points: 0 }]
  );
});

test("final evaluation aplica IMEI antes do perfil e pode cruzar para C", () => {
  const preEvaluation = runPreEvaluation({
    riscoCredito: "ALTISSIMO",
    probabilidadePagamento: "MEDIA",
    quantidadeProcessos: 4,
  });

  assert.equal(preEvaluation.baseScore, 45);

  const result = rules.finalizeEvaluation(
    preEvaluation,
    imeiResult("IMEI_FAIL"),
    5
  );

  assert.equal(result.score, 50);
  assert.equal(result.profile, "C");
  assert.equal(result.decision, "DECLINE");
  assert.deepEqual(result.reasons, [
    "RISCO_ALTISSIMO",
    "PROB_MEDIA",
    "PROCESSOS_4_5",
    "IMEI_FAIL",
  ]);
});
