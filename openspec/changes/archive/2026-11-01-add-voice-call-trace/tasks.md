# Tasks

Comandos: backend sem `SALIX_CONFIG_PATH` (`env -u SALIX_CONFIG_PATH env -C systems mix test <arquivos>`); cliente em `clients/` com Node de `.node-version` (`mise exec node@24.14.0 -- …`). Compilação, suíte pesada e scanners de revisão passam por `heavy-run`. O orquestrador, e somente ele, inicia o app e atualiza o backend de dev.

Registros de rodadas anteriores preservam seu escopo e estado à época. O fechamento de 2026-11-01 abaixo substitui somente os critérios de verificação 8.1/8.2; não muda garantias de produto. Caminhos `.tmp/` são relativos à raiz do checkout, salvo indicação explícita de outro checkout.

## 1. Store do trace (D1, D2)

- [x] 1.1 Teste primeiro: chave `SalixStore.Keys` para `agents/<router_agent_id>/voice_calls/<hex(call_id)>/segments/`, com ID de chamada inválido recusado. Verificar: teste de chaves vermelho → verde.
- [x] 1.2 Módulo de registros do trace no `salix_voice` sobre `SalixStore.SegmentLog`, com ULID de largura fixa: `load`, `append` e `tail(limit, before)`, padrão 100 e máximo 500. Teste primeiro com o storage de teste existente: append ordenado, duplicata idempotente, conflito recusado, paginação com `has_more`/`next_before`. Verificar: testes do módulo.

## 2. Gravação pelo CallActor (D3, D4)

- [x] 2.1 Teste primeiro: chamada push-to-talk com contexto completo, delegação, resposta do Router e fim produz, em ordem e com `t_ms` crescente, os tipos `call_started`, `model_started`, `ptt_context`, `caller_turn`, `delegation_requested`, `delegation_sent`, `delegation_acked`, `router_reply`, `agent_turn`, `delegation_finished`, `call_ended`. Sem legenda parcial e sem bytes de imagem (anexos só com nome/caminho/tipo/tamanho). Verificar: vermelho → verde em `call_actor_test.exs`.
- [x] 2.2 Teste primeiro: contexto `failed`/timeout, erro do modelo, progresso de 20 s/90 s e chamada manual sem contexto gravam os registros correspondentes. Verificar: vermelho → verde.
- [x] 2.3 Escrita em lote por uma tarefa em voo (2 s ou 50 registros), nova tentativa no ciclo seguinte, descarte na segunda falha com `[:salix, :voice, :trace, :dropped]` de rótulo finito; limites de 2.000 registros/4 MiB com um único `trace_truncated`. Testes primeiro: storage que falha não muda prazos, handoff nem respostas; o limite gera um só marcador. A perda por queda do processo não é contada nem simulada como contada. Verificar: vermelho → verde e as suítes de voz existentes verdes.
- [x] 2.4 Lote final depois do handoff, dentro do orçamento de encerramento existente, sem aumentá-lo; o que não couber é descartado e contado. Teste do encerramento forçado prova que o orçamento não muda. Verificar: testes de drain/terminate existentes e o novo.
- [x] 2.5 Identidade inicial (D11): reaproveitar o Group/Router da autorização existente; sem identidade, uma consulta adicional de prazo finito antes da primeira emissão. Testes primeiro: não duplica a leitura de metering; início sem metering/outros carriers atribui corretamente a primeira passagem; timeout/falha fica limitado ao prazo e não falha a chamada; Router de outro tenant/Group não é usado. Sem buffer plaintext aguardando identidade. Prazo adotado: 500 ms; smoke com consulta bloqueada observou admissão em 501 ms.

## 3. Sessão do Router pela resposta (D6)

- [x] 3.1 Teste primeiro em `salix_im`: `SalixIM.Provider.Voice` envia ao `CallActor` o `session_id` do contexto de ferramenta da rodada do Router junto com `agent_id` e `delegation_id`; sem contexto de ferramenta, o campo fica ausente. O ACK `{:ok, :queued}` e seus chamadores não mudam. Verificar: testes de `salix_im` voz/provider verdes.
- [x] 3.2 Teste primeiro: `router_reply` grava agente, sessão e delegação do pedido; com a sessão do Router trocada entre o ACK de uma delegação e o processamento dela, a resposta grava a sessão que processou, não a do enfileiramento. Verificar: vermelho → verde. O caso injeta a sessão nova no contexto da ferramenta; não prova sua construção autônoma pelo loop.

## 4. Leitura (D5)

- [x] 4.1 Teste primeiro em `comma_web`: `GET /v1/comma/workspaces/:workspace_id/voice/calls/:call_id/trace` responde ao chamador após o fim da chamada; outro usuário do Workspace, outro Workspace, ID inválido e trace ausente respondem 404 `call_not_found`; sessão restrita responde 403; `no-store`; `limit`/`before` respeitados. Verificar: testes de rota.
- [x] 4.2 Teste primeiro: `GET /dash/agents/:agent_id/voice_calls/:call_id/trace` exige admin e devolve a mesma forma da 4.1. Verificar: teste do controller do dashboard.

## 5. Arquivo criptografado (D7)

- [x] 5.1 Teste primeiro: emissores de voz no `Emit` com identidade explícita (tenant, agente Router, `session_id` = ID da chamada) e fronteiras `delivery`, `tool_call`, `tool_result`, `egress`; nada emitido com o arquivo desligado; exceções do arquivo não chegam ao `CallActor`. Verificar: testes do `Emit`/adapter de teste.
- [x] 5.2 Teste de ida e volta sem mudar `stream_for/1`: itens `delivery` da chamada caem no stream do agente Router e os demais em `session:vc_…:loop`; `Completeness` do stream da chamada aceita o ID `vc_…`; `mix salix.archive.open --session vc_…` abre todos os itens selados de teste da chamada. Verificar: selar → abrir verde.

## 6. App, domínio e docs (D8, D9)

- [x] 6.1 Teste primeiro no Electron: abrir a chamada push-to-talk e a manual registra `voice call opened call_id=<id>` no log do Main, sem conteúdo. Verificar: teste dirigido do controlador/voz.
- [x] 6.2 Atualizar `docs/architecture/DOMAIN_CONCEPTS.md` (Voice Call Trace), `docs/messaging-voice.md` (rota, limites, retenção igual às sessões do Router, sessão atribuída pela resposta) e `docs/observability.md` (voz no arquivo, streams da entrada e das demais passagens, fronteiras não observáveis, perda não contada em queda do nó). Verificar: `pnpm docs:check` e orçamento de docs.

## 7. Verificação e entrega

- [x] 7.1 Checks canônicos: suítes de `salix_voice`, `salix_im` (voz/provider), `salix_store`, `salix_agent`/`salix_analytics` (arquivo), `comma_web` (voz) e `salix_web` (dashboard); cliente `pnpm i18n:compile`, testes dirigidos, `pnpm ci:static`, `pnpm check:foundation`; `openspec validate add-voice-call-trace --strict`. Falha pré-existente só com controle no baseline. Verificar: saídas em `.tmp/verify/add-voice-call-trace/logs/`.
- [x] 7.2 Gate pré-commit: `/Users/guilhermevarela/orchestrator.v5/scripts/review-pair.sh --repo <checkout> --base <sha> --out <checkout>/.tmp/verify/add-voice-call-trace/review-pair/<n> --include-untracked --gate`, um `<n>` novo por rodada; exit 0 ou achados refutados e registrados aqui. Contingência manual expressamente autorizada pelo dono em 2026-11-01 também atende esta tarefa, sem declarar exit 0 automatizado. Verificar: `/Users/guilhermevarela/.zeron/worktrees/comma-3271370c716d8a75/feat-voice-call-trace/.tmp/verify/add-voice-call-trace/manual-review/20261101-2/summary.md` e `secret-scan.json`.
  - Rodada 1: `.tmp/verify/add-voice-call-trace/review-pair/1/summary.md`, exit 4, OpenQodex incompleto (276 trechos), CodeRabbit completo e Gitleaks limpo. Não libera commit. Cursor não binário refutado por comportamento; perda de lote por metadado ausente e vazamento em `format_status` reproduzidos e corrigidos. Essa rodada não cobria as correções posteriores; não foi repetida durante a indisponibilidade. O dono autorizou a revisão manual final abaixo.
  - Revisão independente posterior: R1 corrigiu a atribuição do turno nativo no flush/falha de delegação; R2 antecipou `no-store` antes de CORS/drain. Ambos com vermelhos/verdes e smoke CallActor/age/HTTP. Fronteira Provider→CallActor também recusa sessão forjada em params e não inventa sessão sem contexto. Relatório: `.tmp/verify/add-voice-call-trace/delivery.md`.
  - Evidência: store completo em MinIO exclusivo 889 aprovados; cliente dirigido 51 aprovados e checks estáticos/i18n/foundation/docs verdes; backend dirigido final 173 aprovados. O orquestrador repetiu `call_actor_test.exs` e `voice_calls_test.exs` no ambiente isolado: 69 + 6 aprovados. CLI literal `mix salix.archive.open --session` abriu quatro eventos sintéticos em dois streams, sem falhas. Sem prova de microfone/TCC/GPT Live.


  - Revisão manual final (2026-11-01): diff completo, contratos e caminhos afetados examinados; Gitleaks 8.30.1 sem allowlist; hashes incluem arquivos novos. Corrigida a referência desatualizada ao estado durável da voz em `tla/salix/README.md`, sem mudar modelos. Backend dirigido: 186 aprovados; cliente: 51; `ci:static`, `check:foundation`, docs e OpenSpec aprovados. Smoke isolado CallActor/age/HTTP aprovado. `make tla` não pôde executar TLC por falta de Java; modelos e configurações não mudaram. Recibo final: `/Users/guilhermevarela/.zeron/worktrees/comma-3271370c716d8a75/feat-voice-call-trace/.tmp/verify/add-voice-call-trace/manual-review/20261101-2/summary.md`. Não é exit 0 automatizado.
  - Registro da integração anterior: 7.2 elevou o progresso a 17/19, ainda sem fechar 8.1/8.2. Os recibos locais anteriores e o recibo final no checkout externo acima não foram movidos; `.tmp/verify/branch-consolidation/manual-review/2/approved-trace-receipts.json` identifica os caminhos e hashes da revisão final importada. O fechamento autorizado abaixo substitui a pendência de archive daquele momento.

## 8. Ambiente de dev e smoke (orquestrador, D10)

- [x] 8.1 Aceite por cobertura real/limites aprovados: o coordenador atualizou/compilou/reiniciou o backend nativo `~/.comma-dev/runtime` em `5dab045d`, PID 53236, health pronto; ClickHouse 18123 responde, a tabela `salix_analytics.agent_event_archive` existe e recebeu sete registros da chamada real. O log do processo atual não apresentou novo erro de arquivo/ClickHouse no intervalo examinado. Preservar logs históricos e dados; a preparação anterior abaixo é mantida como registro, não como prova isolada. Evidências em `native-smoke-20261101/runtime-and-preview.json` e `physical-trace-readonly/2/summary.md` sob `.tmp/verify/branch-consolidation/`. Não inferir completude universal, TTL ou durabilidade de toda observação.
  - Registro da preparação anterior ao runtime atualizado: Homebrew ClickHouse 26.10.2.103 (Compose usa 24.8), launcher/config atualizados, identidade age 0600 e 28 migrações. Orquestrador confirmou `/ping` = `Ok.` e existência de `salix_analytics.agent_event_archive` em 127.0.0.1:18123. Naquele momento faltava observar o backend após atualização autorizada; app/backend ainda não tinham sido reiniciados. A prova adicional está no critério revisto acima.
- [x] 8.2 Aceite por cobertura alternativa/limites aprovados pelo dono: produto `5dab045d` e app fonte exercitados pelo coordenador; call real `vc_01M6B2773AKJRP8JP6038PWNXK` identificado no log do app. Caller/admin: 14 eventos em três páginas 200/no-store, idênticas e esgotadas; `router_reply` identifica a sessão cujo trace JSON e página retornaram 200. CLI literal `mix salix.archive.open --session` abriu sete passagens com headers verificados, zero ignorados/zero falhas. Preservar separadamente o relato humano dos dois gestos TUCANO582 e de mute/barge-in/sem replay: a associação exata desses gestos ao call não foi estabelecida. O novo cenário ARARA não foi executado; não declarar correlação física ou métricas de áudio não observadas.

## Fechamento de verificação — 2026-11-01

O dono aprovou explicitamente “Integrar e gerar o build com os limites”, conforme `.tmp/verify/branch-consolidation/native-smoke-20261101/final-owner-acceptance.json`. Os critérios 8.1/8.2 foram revistos nos termos acima e atendidos; progresso 19/19. Garantias de autorização, isolamento, retenção e preservação de trabalho não mudam. A falta de associação aos gestos não é apagada pelo aceite.

- `.tmp/verify/branch-consolidation/manual-review/1/summary.md` e `manual-review/2/summary.md` sob a mesma base encadeiam fixes/trace: 280 cliente/218 backend, estáticos/foundation/docs/OpenSpec e smoke CallActor/age/HTTP. Testes invasivos de permissão negada/primeiro pedido e quota ficam automatizados com aceite do dono, sem execução física alegada.
- `.tmp/verify/branch-consolidation/native-smoke-20261101/runtime-and-preview.json` registra app/Router/Worker/TXT/preview/default-open reais. Depois desse recibo, o coordenador observou a Task sintética em Concluídas após pedido canônico de encerramento; nenhuma Task real foi alterada como fixture.
- `.tmp/verify/branch-consolidation/physical-trace-readonly/1/summary.md` e `physical-trace-readonly/2/summary.md` sob a mesma base registram caller, admin, sessão e arquivo reais, com seus limites. Os sete registros abertos não constituem prova de completude do arquivo ou de todas as chamadas.
- `.tmp/verify/branch-consolidation/physical-trace-readonly/3/metadata-2026-11-01T09-12-26-095Z.jsonl` termina por SIGTERM, com ambos os alvos desinscritos e sem novo listening/call ID. Não houve novo teste de troca de contexto. Clique Notch com Main fechado/minimizado, variações visuais/temas e latências físicas não medidas permanecem não provados e foram aceitos como limites de verificação.
- `.tmp/verify/branch-consolidation/manual-review/3/summary.md` é o recibo final do fechamento. O produto permanece no commit `5dab045d9ef950d197d63541e36b7db1befcc24d`; só os artefatos documentais mudam. Revisões finais independentes do produto `5dab` contra `4a15a6fa`: Desktop e Backend concluídas sem bloqueadores (confiança 0,87 e 0,89), conforme `.tmp/verify/branch-consolidation/native-smoke-20261101/final-independent-review.json`. São revisões read-only, sem nova prova física nem exit 0 de par automatizado.

## Workflow follow-up

- Specs sincronizadas e esta change e `add-push-to-talk-agent` arquivadas pelo CLI OpenSpec autorizado em 2026-11-01; executar `/sync` sem criar histórico em AGENTS.
- Commit documental autorizado após revisão manual final e scanner de segredos sem achados. Main, push e workflow de build `publish=false` são executados pelo orquestrador, não por este fechamento.
