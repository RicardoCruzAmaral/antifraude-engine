const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadAnalyzeForCharacterization,
  withIsolatedEnvironment,
  withMutedConsole,
} = require("../helpers/analyze-characterization-harness.cjs");

const { exports: analyzeExports } = loadAnalyzeForCharacterization();
const rules = analyzeExports.__characterization;

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
