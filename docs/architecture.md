# Arquitetura do motor antifraude

## Fluxo de análise

`api/analyze.ts` valida o método HTTP, cria o trace, resolve a configuração e compõe os adapters. O `AnalyzeAntifraudUseCase` normaliza a entrada, consulta o cache e, em caso de miss, executa enrichment, pré-avaliação, IMEI quando aplicável, avaliação final, cache e auditoria. O resultado retorna à API, que preserva o status e o body HTTP.

## Responsabilidades por camada

- `api`: adaptador HTTP/Vercel e composition root.
- `application`: orquestração do caso de uso e ports necessários pela aplicação.
- `domain`: contratos e regras puras de decisão, sem SDKs ou providers externos.
- `infrastructure`: implementação dos ports para TechTrail, IMEI.info e Supabase.

Os principais ports são `EnrichmentProvider`, `ImeiProvider`, `DecisionCache`, `DecisionAuditRepository` e `ProviderRawRepository`.

## Fonte única das regras

A fonte ativa das regras é `src/domain/engine`:

- hard blocks: `hardBlocks.ts`;
- scoring: `scoring.ts`;
- profiles: `profiles.ts`;
- sequência de pré-avaliação e finalização: `evaluation.ts`.

O motor possui somente as decisões `APPROVE` e `DECLINE`.

Os adapters TechTrail e IMEI.info ficam em `src/infrastructure/providers`. Cache, auditoria de decisão e respostas raw ficam em `src/infrastructure/persistence/supabase`, implementando os ports de `src/application/ports`.

## Débitos fora desta refatoração

- Cache V2: chave, versionamento, invalidação, concorrência e diferenciação de indisponibilidade versus miss.
- Revisão funcional de hard blocks, pesos, profiles e política de IMEI.
- Revisão da semântica e retenção dos registros de auditoria/raw.
- Observabilidade: nomes históricos dos events, timestamps, significado de sucesso da persistência e peculiaridade de `score_computed`.
- Estratégia explícita para indisponibilidade de providers e persistência.
- Segurança, privacidade, retenção e mascaramento de dados sensíveis.

## Cache V2 — PLANNED / NOT ACTIVE

A fundação do Cache V2 existe em paralelo ao `decision_cache` V1. Nenhum port ou adapter V2 está injetado no `AnalyzeAntifraudUseCase`; portanto, não há leitura, escrita ou mudança de decisão causada pelo V2 nesta etapa.

Os mecanismos planejados são independentes:

1. `analysis_replay`: idempotência da mesma análise, identificada por `proposalId` opcional, HMAC canônico dos inputs relevantes, `ruleVersion` e versão do schema do cache.
2. `techtrail_evidence_cache`: evidência normalizada da pessoa. Sua identidade usa token HMAC do CPF, provider e versões de contrato, normalização e schema.
3. `imei_evidence_cache`: evidência normalizada do aparelho. Sua identidade usa token HMAC do IMEI, provider, serviço/produto e versões.

### Decisão conhecida do TechTrail V1

O cache TechTrail representa a pessoa/CPF. Alterar `proposalId`, email, telefone, CEP, valor, produto, modelo declarado, IMEI, fingerprint, `visitorId` ou canal não invalida automaticamente a evidência durante seu TTL. Motivos eventualmente influenciados pelo contexto da primeira consulta também permanecem na evidência durante esse período. Essa limitação é consciente e deverá ser reavaliada com dados de produção.

O TTL TechTrail é configurado por `TECHTRAIL_CACHE_TTL_DAYS`, com default inicial de 30 dias. O IMEI possui configuração independente, `IMEI_CACHE_TTL_DAYS`, deliberadamente sem default até uma política ser aprovada.

### Raw e segurança

Os caches V2 armazenam somente a evidência normalizada necessária para reutilização e uma `rawReference` opcional. O payload original permanece nos repositories raw de auditoria.

CPF e IMEI nunca são chaves cruas nas tabelas V2: são tokenizados por HMAC-SHA-256 com `EVIDENCE_LOOKUP_HMAC_KEY`. O segredo deve ser separado das credenciais dos providers, nunca logado e rotacionado por procedimento compatível com invalidação/reindexação. As tabelas têm RLS habilitado e não concedem acesso direto a `anon` ou `authenticated`. Retenção e descarte ainda precisam de política formal.

### Flags preparadas

Os defaults preservam integralmente o V1:

- `ANALYSIS_REPLAY_ENABLED=false`;
- `CACHE_V2_WRITE_ENABLED=false`;
- `CACHE_V2_READ_TECHTRAIL_ENABLED=false`;
- `CACHE_V2_READ_IMEI_ENABLED=false`;
- `DECISION_CACHE_V1_READ_ENABLED=true`.

As flags estão somente na configuração V2 não consumida pelo fluxo ativo. A primeira ativação proposta é shadow write, sem leitura V2.
