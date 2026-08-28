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

## Cache V2 — SHADOW WRITE AVAILABLE / READ NOT ACTIVE

A fundação do Cache V2 existe em paralelo ao `decision_cache` V1. Quando `CACHE_V2_WRITE_ENABLED=true`, o composition root injeta somente writers shadow best-effort. Nenhum cache V2 é lido, nenhum provider é pulado e nenhuma evidência V2 influencia score, reasons, profile ou decisão. Com a flag desligada, nenhuma dependência V2 é necessária e nenhuma escrita é tentada. O `decision_cache` V1 continua sendo consultado e gravado normalmente.

Os mecanismos planejados são independentes:

1. `analysis_replay`: idempotência da mesma análise, identificada por `proposalId` opcional, HMAC canônico dos inputs relevantes, `ruleVersion` e versão do schema do cache.
2. `techtrail_evidence_cache`: evidência normalizada da pessoa. Sua identidade usa token HMAC do CPF, provider e versões de contrato, normalização e schema.
3. `imei_evidence_cache`: evidência normalizada do aparelho. Sua identidade usa token HMAC do IMEI, provider, serviço/produto e versões.

### Decisão conhecida do TechTrail V1

O cache TechTrail representa a pessoa/CPF. Alterar `proposalId`, email, telefone, CEP, valor, produto, modelo declarado, IMEI, fingerprint, `visitorId` ou canal não invalida automaticamente a evidência durante seu TTL. Motivos eventualmente influenciados pelo contexto da primeira consulta também permanecem na evidência durante esse período. Essa limitação é consciente e deverá ser reavaliada com dados de produção.

O TTL TechTrail é configurado por `TECHTRAIL_CACHE_TTL_DAYS`, com default inicial de 30 dias. O IMEI possui configuração independente, `IMEI_CACHE_TTL_DAYS`, deliberadamente sem default até uma política ser aprovada. Sem TTL IMEI, o shadow write é registrado como skipped. O replay segue a mesma regra com `ANALYSIS_REPLAY_TTL_DAYS`, também sem default funcional.

Shadow writes aceitos:

- TechTrail: somente resposta `ok` com summary; identidade da pessoa pelo token HMAC do CPF.
- IMEI: `IMEI_OK`, `IMEI_INVALID` e `IMEI_BRAND_MISMATCH` são evidências semânticas; `IMEI_FAIL`, timeout e erros técnicos não são persistidos no V2.
- Replay: resposta concluída do engine ou cache V1, somente quando o TTL foi configurado. O replay é gravado, mas nunca consultado para responder nesta fase.

A telemetria shadow usa um sink interno separado. Ela não é adicionada aos `events` públicos do response, preservando o contrato HTTP e o golden master.

### Replay input deliberado

O hash canônico inclui: CPF, nome, email, telefone, CEP, valor, parceiro, canal, proposta, modelo declarado, IMEI e os campos de device atualmente devolvidos ou observados pelo motor (`ip`, `visitorId`, OS, GPU, cores, mobilidade, versão do OS, browser, dimensões de tela e provider do fingerprint).

Ficam excluídos: `sessionId`, `collectedAt`, request IDs técnicos do fingerprint, timestamps de transporte, propriedades extras do device e a ordem das propriedades JSON. Esses campos não alteram hoje a decisão nem o snapshot público relevante. `ruleVersion` não entra no input hash porque participa separadamente da identidade e compatibilidade do replay.

### Raw e segurança

Os caches V2 armazenam somente a evidência normalizada necessária para reutilização e uma `rawReference` opcional. O payload original permanece nos repositories raw de auditoria.

CPF e IMEI nunca são chaves cruas nas tabelas V2: são tokenizados por HMAC-SHA-256 com `EVIDENCE_LOOKUP_HMAC_KEY`. O segredo deve ser separado das credenciais dos providers, nunca logado e rotacionado por procedimento compatível com invalidação/reindexação. As tabelas têm RLS habilitado e não concedem acesso direto a `anon` ou `authenticated`. Retenção e descarte ainda precisam de política formal.

### Flags preparadas

Os defaults preservam integralmente o V1:

- `ANALYSIS_REPLAY_ENABLED=false`;
- `CACHE_V2_WRITE_ENABLED=false` — quando `true`, habilita apenas shadow write;
- `CACHE_V2_READ_TECHTRAIL_ENABLED=false`;
- `CACHE_V2_READ_IMEI_ENABLED=false`;
- `DECISION_CACHE_V1_READ_ENABLED=true`.

As flags de read continuam não consumidas pelo fluxo. `ANALYSIS_REPLAY_ENABLED` permanece reservado para a futura leitura/replay; shadow write é controlado exclusivamente por `CACHE_V2_WRITE_ENABLED`.
