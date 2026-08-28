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

## Cache V2 — SHADOW WRITE AVAILABLE / EVIDENCE READS BEHIND FLAGS

A fundação do Cache V2 existe em paralelo ao `decision_cache` V1. Quando `CACHE_V2_WRITE_ENABLED=true`, o composition root injeta writers shadow best-effort. As leituras TechTrail e IMEI são controladas independentemente por flags; um HIT evita o respectivo provider, mas nunca reutiliza uma decisão. Analysis Replay read permanece inativo. Com as flags desligadas, nenhuma dependência V2 é necessária. O `decision_cache` V1 continua ativo por default.

Os mecanismos planejados são independentes:

1. `analysis_replay`: idempotência da mesma análise, identificada por `proposalId` opcional, HMAC canônico dos inputs relevantes, `ruleVersion` e versão do schema do cache.
2. `techtrail_evidence_cache`: evidência normalizada da pessoa. Sua identidade usa token HMAC do CPF, provider e versões de contrato, normalização e schema.
3. `imei_evidence_cache`: evidência normalizada do aparelho. Sua identidade usa token HMAC do IMEI, provider, serviço/produto e versões.

### Decisão conhecida do TechTrail V1

O cache TechTrail representa a pessoa/CPF. Alterar `proposalId`, email, telefone, CEP, valor, produto, modelo declarado, IMEI, fingerprint, `visitorId` ou canal não invalida automaticamente a evidência durante seu TTL. Motivos eventualmente influenciados pelo contexto da primeira consulta também permanecem na evidência durante esse período. Essa limitação é consciente e deverá ser reavaliada com dados de produção.

Os TTLs TechTrail e IMEI possuem defaults iniciais de 30 dias em `TECHTRAIL_CACHE_TTL_DAYS` e `IMEI_CACHE_TTL_DAYS`. São configurações independentes e cada uma aceita override próprio. O replay continua sem default funcional em `ANALYSIS_REPLAY_TTL_DAYS`.

Shadow writes aceitos:

- TechTrail: somente resposta `ok` com summary; identidade da pessoa pelo token HMAC do CPF.
- IMEI: fatos válidos equivalentes a `IMEI_OK`/`IMEI_INVALID` são persistidos; mismatch e marca esperada são contexto da proposta e são reaplicados na leitura. `IMEI_FAIL`, timeout e erros técnicos não são persistidos no V2.
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

`ANALYSIS_REPLAY_ENABLED` continua sem leitura no fluxo. Shadow write é controlado exclusivamente por `CACHE_V2_WRITE_ENABLED`.

## TechTrail Cache V2 READ — AVAILABLE BEHIND FLAG

`CACHE_V2_READ_TECHTRAIL_ENABLED=false` continua sendo o default. Quando habilitada, a leitura ocorre depois do cache de decisão V1 e antes da chamada TechTrail. `DECISION_CACHE_V1_READ_ENABLED` agora governa explicitamente apenas a leitura antecipada V1; seu default permanece `true` e as escritas V1 continuam ativas.

A identidade consultada é o token HMAC do CPF, provider e versões de contrato, normalizer e schema. Email, telefone, CEP, valor, proposta, aparelho, IMEI, fingerprint e canal não participam dessa identidade.

- `HIT` fresh, `COMPLETE` e compatível: evita a chamada paga TechTrail e usa `normalizedEvidence`; hard blocks, score, IMEI e decisão são recalculados.
- `MISS`, `EXPIRED`, `INCOMPATIBLE` ou `BACKEND_ERROR`: chama TechTrail exatamente uma vez, sem stale-while-revalidate.
- HMAC/config/adapter indisponível: bypass best-effort e chamada normal ao provider.

Um HIT não cria `enrichment_raw`, não renova `fetchedAt`/`expiresAt` e não dispara shadow write da mesma evidência. Provenance (`state`, source, fetched/expiry e `rawReference`) é acrescentada somente à cópia dos events persistida em `decision_log`; não aparece nos events do response. Para preservar a sequência pública histórica, o step legado `enrichment_raw_saved` continua presente no response mesmo no HIT, embora nenhuma inserção raw seja executada — débito semântico de observabilidade já conhecido.

## IMEI Cache V2 READ — AVAILABLE BEHIND FLAG

`CACHE_V2_READ_IMEI_ENABLED=false` é o default. Quando habilitada, a leitura ocorre somente depois da pré-avaliação e de qualquer hard block, e somente quando há `imeiCode`. A identidade é: token HMAC do IMEI normalizado + provider + serviço/produto atual + versões do contrato do provider, normalizer e schema. CPF, proposta, valor, dados de contato, fingerprint e modelo declarado não entram diretamente na chave; o serviço permanece porque identifica o produto factual consultado no provider atual.

- `HIT` fresh, `COMPLETE` e compatível: evita a chamada paga ao IMEI.info e reutiliza somente a evidência factual; score, reasons, profile e decisão são recalculados.
- `MISS`, `EXPIRED`, `INCOMPATIBLE` ou `BACKEND_ERROR`: chama o provider exatamente uma vez, sem stale-while-revalidate.
- HMAC/config/adapter indisponível: bypass best-effort e chamada normal ao provider.

A evidência factual não persiste `brandExpected` nem um `IMEI_BRAND_MISMATCH` contextual. Na leitura, a marca retornada é comparada novamente com `modelo_declarado` da proposta atual. O normalizer IMEI foi versionado como `imei-normalizer-v2`, invalidando automaticamente artefatos antigos que congelavam mismatch. A seleção do serviço real e a semântica do provider permanecem inalteradas.

Um HIT não cria `imei_raw`, não renova `fetchedAt`/`expiresAt` e não dispara shadow rewrite. Proveniência (source, artifact/reference, fetched/expiry, age, provider e service) fica somente na auditoria interna; o contrato HTTP público não muda. `IMEI_CACHE_TTL_DAYS` tem default independente de 30 dias e aceita override por ENV.

Analysis Replay read continua inexistente.
