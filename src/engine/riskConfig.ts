export const riskConfig = {
  hardBlocks: {
    motivos: [
      "NOME DIVERGENTE",
      "CPF INVÁLIDO",
      "CPF COM SITUAÇÃO IRREGULAR",
      "CPF NÃO ENCONTRADO",
      "CPF CONSTA OBITO",
      "CPF SOCIO DE CNAE IMPEDIDO",
      "CONSTA MANDADO DE PRISAO",
      //"CONSTAM 5 AÇÕES CIVEIS COMO AUTOR",
      "POSSUI ACAO CRIMINAL",
    ],
    riscoPagamentoCombo: {
      riscoCredito: "ALTISSIMO",
      probabilidadePagamento: "BAIXA",
    },
  },

  weights: {
    divergencias: {
      EMAIL_DIVERGENTE: 0,
      TELEFONE_DIVERGENTE: 0,
      CEP_DIVERGENTE: 5,
    },

    riscoCredito: {
      ALTISSIMO: 20,
      ALTO: 15,
      MEDIO: 10,
      BAIXO: 5,
      BAIXISSIMO: 0,
    },

    probabilidadePagamento: {
      ALTISSIMO: 0,
      ALTO: 5,
      MEDIO: 10,
      BAIXO: 15,
      BAIXÍSSIMO: 50,
    },

    quantidadeProcessos: [
      { min: 1, max: 3, points: 10 },
      { min: 4, max: 5, points: 20 },
      { min: 6, points: 25 },
    ],

    celular: {
      highValueMin: 5000,
      points: 0,
    },
  },

  profiles: {
    A: { maxScore: 10 },
    B1: { maxScore: 25 },
    B2: { maxScore: 45 },
    C: { minScore: 46 },
  },
};