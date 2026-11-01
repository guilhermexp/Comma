# Tasks

Comandos: backend sem `SALIX_CONFIG_PATH` (`env -u SALIX_CONFIG_PATH env -C systems mix test <arquivos>`); cliente em `clients/` com Node de `.node-version` (`mise exec node@24.14.0 -- …`). Compilação, suíte pesada e scanners de revisão passam por `heavy-run`. O orquestrador, e somente ele, inicia o app e atualiza o backend de dev.

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
- [x] 7.2 Gate pré-commit: `/Users/guilhermevarela/orchestrator.v5/scripts/review-pair.sh --repo <checkout> --base <sha> --out <checkout>/.tmp/verify/add-voice-call-trace/review-pair/<n> --include-untracked --gate`, um `<n>` novo por rodada; exit 0 ou achados refutados e registrados aqui. Contingência manual expressamente autorizada pelo dono em 2026-11-01 também atende esta tarefa, sem declarar exit 0 automatizado. Verificar: `.tmp/verify/add-voice-call-trace/manual-review/20261101-2/summary.md` e `secret-scan.json`.
  - Rodada 1: `.tmp/verify/add-voice-call-trace/review-pair/1/summary.md`, exit 4, OpenQodex incompleto (276 trechos), CodeRabbit completo e Gitleaks limpo. Não libera commit. Cursor não binário refutado por comportamento; perda de lote por metadado ausente e vazamento em `format_status` reproduzidos e corrigidos. Essa rodada não cobria as correções posteriores; não foi repetida durante a indisponibilidade. O dono autorizou a revisão manual final abaixo.
  - Revisão independente posterior: R1 corrigiu a atribuição do turno nativo no flush/falha de delegação; R2 antecipou `no-store` antes de CORS/drain. Ambos com vermelhos/verdes e smoke CallActor/age/HTTP. Fronteira Provider→CallActor também recusa sessão forjada em params e não inventa sessão sem contexto. Relatório: `.tmp/verify/add-voice-call-trace/delivery.md`.
  - Evidência: store completo em MinIO exclusivo 889 aprovados; cliente dirigido 51 aprovados e checks estáticos/i18n/foundation/docs verdes; backend dirigido final 173 aprovados. O orquestrador repetiu `call_actor_test.exs` e `voice_calls_test.exs` no ambiente isolado: 69 + 6 aprovados. CLI literal `mix salix.archive.open --session` abriu quatro eventos sintéticos em dois streams, sem falhas. Sem prova de microfone/TCC/GPT Live.


  - Revisão manual final (2026-11-01): diff completo, contratos e caminhos afetados examinados; Gitleaks 8.30.1 sem allowlist; hashes incluem arquivos novos. Corrigida a referência desatualizada ao estado durável da voz em `tla/salix/README.md`, sem mudar modelos. Backend dirigido: 186 aprovados; cliente: 51; `ci:static`, `check:foundation`, docs e OpenSpec aprovados. Smoke isolado CallActor/age/HTTP aprovado. `make tla` não pôde executar TLC por falta de Java; modelos e configurações não mudaram. Recibo final: `.tmp/verify/add-voice-call-trace/manual-review/20261101-2/summary.md`. Não é exit 0 automatizado.
  - Delta desta cópia: somente 7.2 concluída (17/19). Evidências históricas acima pertencem a `/Users/guilhermevarela/Documents/Projetos/SelfHosting/Comma-ptt-integration/.tmp/verify/add-voice-call-trace/`; novos recibos ficam neste checkout. O coordenador deve aplicar o delta à cópia canônica. 8.1/8.2 seguem abertas; não arquivar a change.

## 8. Ambiente de dev e smoke (orquestrador, D10)

- [ ] 8.1 ClickHouse no launcher nativo (Homebrew, porta local), URL e destinatário age no `config.json` local, identidade privada em `~/.comma-dev/archive-identity.txt`, migrações pelo caminho canônico do `compose.yaml`. Verificar: `/ping` responde, o backend deixa de registrar `econnrefused` e a tabela `agent_event_archive` existe.
  - Preparado: Homebrew ClickHouse 26.10.2.103 (Compose usa 24.8), launcher/config atualizados, identidade age 0600 e 28 migrações. Orquestrador confirmou `/ping` = `Ok.` e existência de `salix_analytics.agent_event_archive` em 127.0.0.1:18123. Falta observar o backend após atualização autorizada; app/backend de dev não foram reiniciados. Não marcar este item só pela preparação.
- [ ] 8.2 Backend de dev no commit entregue e app reiniciado. O dono faz um gesto push-to-talk real. Verificar: o ID da chamada aparece no log do app; o trace pela rota do chamador mostra os registros da 2.1 com tempos; o `router_reply` abre o trace da sessão do Router no dashboard; `mix salix.archive.open --session <call_id>` abre as passagens.

## Workflow follow-up

- Arquivar com `/openspec-archive-change` depois de todas as tarefas; `/sync` e `/cleanup`. Sem push sem autorização do dono.
