# Tarefas

Esta checklist descreve a implementação após a aprovação da Fase 1 pelo orquestrador. Itens `[x]` continuam válidos; itens do fluxo retirado saem da lista. Mudanças comportamentais começam por regressão que falha e terminam com o caminho corrigido. Não alterar helper Swift, NotchHost, outras changes ou `openspec/specs/`.

Ordem da Fase 2: backend (4.x) → contrato/client e janela de voz (5.x) → controlador (6.x) e apresentação (7.9) → remoções (8.3–8.4) → verificação integrada (8.2, 9.x). Manter o código de captura/atalho já concluído.

Comandos em `clients/`, com Node de `.node-version` (`mise exec node@24.14.0 -- …`): `pnpm i18n:compile` antes dos testes; `NODE_ENV=test pnpm vitest run <arquivo>`; `pnpm i18n:check`; `pnpm ci:static`; `pnpm check:foundation`; `pnpm test:unit --maxWorkers=4`. Backend em `systems/`: `mix test apps/salix_voice/test apps/comma_web/test`. O orquestrador, e somente ele, inicia o app e atualiza o backend de dev.

## 1. Contrato e atalho com apertar/soltar (D1)

- [x] 1.1 Escrever primeiro os testes de schema em `packages/chat-contract` para `push-to-talk.shortcut` (host, aceita `null`) e `push-to-talk.pressed`/`push-to-talk.released` (cliente, `frontmostApp` opcional), vendo-os falhar; adicionar os frames e rodar `pnpm generate:native-bridge`. Verificar: testes passam e `pnpm --filter @comma/native-bridge generate:partners:check` fica limpo.
- [x] 1.2 `GlobalHotKey.swift` com `onReleased` (`kEventHotKeyReleased`) e segunda instância no `EdgeChatController`/`SideChatCommandServer` que emite `push-to-talk.pressed` (com `NSWorkspace.frontmostApplication`) e `push-to-talk.released`, sem tocar no `toggle()` da sidebar. Verificar: `pnpm --dir apps/electron build:native:side-chat` compila.
- [x] 1.3 Em `native-side-chat.ts`, registro/desregistro do atalho de falar com resposta, reenvio após reinício do helper e callbacks `onPushToTalkPressed/Released` e `onPushToTalkHelperRestarted`, com teste primeiro em `native-side-chat*.test.ts` usando uma fixture `side-chat-shortcut-*-host.cjs` que emite os frames novos. Verificar: testes passam.

## 2. Ajustes (D8)

- [x] 2.1 Campos preservados `pushToTalkEnabled`, `pushToTalkShortcut`, `pushToTalkSendScreen` no schema, patch e padrões; persistência em `app-preferences.ts`. Verificação existente: padrões, merge e ida/volta em `app-preferences.test.ts` e contrato de preferências. A remoção do campo de voz está em 5.4.
- [x] 2.2 Conflito do atalho de falar com o da sidebar e o do "Abrir Comma" em `sideChatShortcutConflict.ts`/`commaAppShortcuts.tsx`, com teste primeiro em `sideChatShortcutConflict.test.ts`. Verificar: teste passa.
- [x] 2.3 Base da seção "Falar com o agente": liga/desliga indisponível sem sidebar, atalho, envio do print, aviso de privacidade e textos nos três idiomas. Verificação existente: Ajustes e conflitos. A revisão para chamada e os prints atualizados estão em 5.4 e 9.1.

## 3. Captura de tela (D3)

- [x] 3.1 Módulo de captura no Main com `desktopCapturer` (monitor do cursor, redução a 2560 px, PNG ou JPEG ≤10 MB, recorte da área ou de 800×500 pt em volta do cursor, conversão de pontos para pixels do print, estados de permissão). Teste primeiro com dublês de `desktopCapturer`/`screen`/`nativeImage` cobrindo monitor secundário com escala 2×, área perto da borda, permissão negada e limite de 10 MB. Verificar: testes passam.
- [x] 3.2 Atualizar `electron_macos_screen_capture_usage` nos três idiomas para cobrir áudio e print enviado ao agente. Verificar: `macos-info-plist-strings.test.ts` e `pnpm i18n:check` passam.

## 4. Backend da chamada e do contexto (D13, D16, D17)

- [ ] 4.1 Primeiro reproduzir em `salix_voice` o modo `push_to_talk`: sem saudação, perfil não bloqueia, delegação ativa, Router pode responder, `voice.call_started/ended` e teto de 10 min. Implementar em `VoiceCalls.start`/CallActor sem alterar o modo de conversa manual. Verificar: testes de modo e regressões da chamada em `mix test apps/salix_voice/test`.
- [ ] 4.2 Primeiro testar `POST …/voice/calls/:call_id/context` em `comma_web` com escopo `{tenant, group, user}`, texto e anexos `{file_id|path, name, mime}`. Implementar texto como `session.context.append`, armazenamento dos anexos no CallActor e consumo na próxima delegação por `attachments:`. Verificar: escopos recusados, texto recebido no transporte e anexos na primeira delegação, ausentes na segunda, em `codex_test.exs`/`voice_calls_test.exs`.
- [ ] 4.3 Reproduzir resposta do Router após encerrar a chamada com delegação pendente, inclusive a tentativa de `im_api.voice.say`. Garantir que o trabalho aceito e seu texto continuem na conversa pelo caminho existente, sem nova chamada ou mutação fora de `ConversationServer -> ConversationActor`. Verificar: regressão falha antes e passa após encerramento pelo teto e desligamento do PTT.

## 5. Contrato/client, janela de voz e contexto (D14, D17, D18)

- [ ] 5.1 Atualizar o contrato/client em `packages/app/src/api/`: início com `push_to_talk`, contexto textual e anexos, eventos e encerramento existentes; remover `sayVoiceCall`. Verificar: teste HTTP do cliente exercita requests/respostas reais e preserva `busy`/`plan_limit`, sem revalidar apenas declarações.
- [ ] 5.2 Converter `readAloudPeer.ts`/`PushToTalkVoiceApp` e `voice-window.ts` para microfone real mutado por padrão, sinalização, reprodução, comando de mute e nível por `AnalyserNode` → IPC. Renomear o peer para refletir a chamada. Primeiro testar soltura antes da conexão e teardown; em `security.ts`, testar mídia áudio-apenas para `push-to-talk-voice` com janela principal fechada, origem/frame incorretos, vídeo negado e demais papéis que continuam negados. Verificar: testes de voz, segurança e opções de janela.
- [ ] 5.3 Ligar captura/upload existentes à rota `context`, com texto de app/cursor/área/nomes e dois anexos. Primeiro reproduzir print pendente na soltura e "Enviar print" desligado. Verificar: upload + contexto com anexos; anexos seguem uma única delegação; sem print há apenas texto, nenhum pedido de permissão/captura/upload e nenhum rascunho consumido.
- [ ] 5.4 Remover `pushToTalkSpeakReplies` do schema/patch/padrões/consumidores e sua UI/i18n; eliminar a dependência PTT → Reunião e erros de transcrição. Atualizar aviso de privacidade para GPT Live e Router, preservando atalhos/conflitos/permissões. Verificar: testes de preferências e Ajustes, `pnpm i18n:compile`, `pnpm i18n:check` e geração das capacidades pelo fluxo existente, sem editar artefatos gerados.

## 6. Controlador do turno e sobreposição (D2, D4)

- [ ] 6.1 Reescrever `PushToTalkController` para sessão de voz. Primeiro testar em `push-to-talk.test.ts`: pressed abre/pré-aquece e desmuta; released muta sem esperar print; conexão tardia não desmuta; toque <0,3 s/cancelamento; captação de 120 s; réplica em 90 s reusa sessão; pendência retém sessão; teto de 10 min fecha; resposta tardia vai a `ready`; `busy`/`plan_limit` dão erro; troca de conta encerra e invalida continuações; bloqueio/suspensão/reinício do helper. Verificar: cada regressão falha antes e passa depois; executar o controlador real em smoke sem lançar Electron.
- [x] 6.2 Janela `push-to-talk-overlay` (registro do papel em `feature-surfaces.ts`, `managed-window.ts`, `window-options.ts`, `modules/ipc/index.ts`, `preload/native-bridge.ts`, capacidades por papel, `renderComma.tsx`), evento de estado e capacidade `pushToTalk.setRegion`; tela React com arrasto e pílula seguindo `~/.agents/skills/impeccable/SKILL.md`. Testes primeiro: `window-options.test.ts` (sem foco, nível, todos os espaços) e teste jsdom da tela (arrasto gera área, nova área substitui, pílula por estado). Atualizar `e2e/window-census.spec.ts`. Verificar: testes passam.
- [ ] 6.3 Integrar runtime, controlador e janela de voz em `electron-main.module.ts`/`index.ts`: fence por geração, mudanças de preferência, encerramento no desligamento/logout e nenhuma abertura automática de janela. Verificar: testes do runtime/controlador, incluindo continuações de upload/contexto da conta antiga; `pnpm ci:static` e `pnpm check:foundation`.

## 7. UX preservada e apresentação da chamada (D2, D4, D8–D10, D14–D16)

- [x] 7.1 Contrato do atalho: `push-to-talk.shortcut { binding: { keyCode?, modifiers } | null }`, `push-to-talk.released { cancelled }`, `push-to-talk.permission { inputMonitoring }` e o pedido de permissão; schema dos ajustes aceita `key: null` com ≥2 modificadores e padrão `⌃⌥`. Testes de schema primeiro; `pnpm generate:native-bridge`. Verificar: testes e `generate:partners:check` passam.
- [x] 7.2 Event tap de leitura no `SideChatHost` (D10): pressed/released/cancelled, modificador a mais não dispara, reativação após timeout, estado e pedido do Monitoramento de Entrada com nova checagem a cada 2 s; Carbon continua para tecla comum. Verificar: `build:native:side-chat` compila; fixture do helper cobre os frames novos.
- [x] 7.3 Adaptador em `native-side-chat.ts`/`native-hotkey.ts` para o contrato novo (`register` devolve o estado da permissão, `onReleased({ cancelled })`, `onPermission`), com teste primeiro na fixture. Verificar: testes passam.
- [x] 7.4 Ajustes: gravador de atalho aceita só modificadores, conflitos consideram combinações só de modificadores, linha de estado do Monitoramento de Entrada com botão para os Ajustes do Sistema; textos nos três idiomas. Testes primeiro (`AppSettingsRoute.test.tsx`, `sideChatShortcutConflict.test.ts`, teste do gravador). Verificar: testes, `pnpm i18n:check` e prints da seção em `.tmp/push-to-talk/`.
- [x] 7.5 Cena de voz no notch (D9): campo `voice` no payload, view no `NotchHost` com estado, barras de nível e cor por estado, ação de erro; `NotchService.setVoice` e `visible()`. Testes primeiro em `notch.test.ts` e no contrato. Verificar: testes, `generate:partners:check`, build do `NotchHost` e prints da cena em cada estado em `.tmp/push-to-talk/`.
- [x] 7.6 Tela da sobreposição (D4): companheiro que segue o cursor com nível, espera e balão; traço livre que substitui o anterior e some com fade; balão clicável; seguindo `~/.agents/skills/impeccable/SKILL.md`. Testes jsdom primeiro (traço, balão, estados). Verificar: testes e prints em `.tmp/push-to-talk/`.
- [x] 7.7 Janela no Main (D4): acompanhamento do cursor e troca de monitor, região interativa do balão, `setLevel`/`setCaption`/`onStroke`/`onCaptionClick`. Teste primeiro em `push-to-talk-overlay.test.ts`. Verificar: testes passam.
- [x] 7.8 Captura com traço (D3): pontos do traço → caixa, recorte com margem e traço desenhado no bitmap do print e do recorte. Teste primeiro em `push-to-talk-screen.test.ts` (traço em monitor 2×, traço na borda, pixels do traço presentes no print). Verificar: testes passam.
- [ ] 7.9 Projetar `connecting`/`listening`/`thinking`/`speaking`/`idle`/`ready` no notch e companheiro existentes, nível real e legenda frase a frase. Preservar interrupção por novo aperto na mesma sessão, captura sem overlay e erros no companheiro com notch desligado. Vincular resposta tardia à chamada/delegação da conta original, com clique para sidebar e sem religação automática. Verificar: regressões PTT/renderer para estados, resposta digitada não correlacionada, PTT desligado com pendência e nenhuma janela aberta sem clique.
- [ ] 7.10 Verificar a integração de cliente após i18n compilado: suíte PTT, voz, segurança e Settings, `pnpm i18n:check`, `pnpm ci:static` e `pnpm check:foundation` verdes. Rodar `pnpm test:unit --maxWorkers=4` e reportar o resultado como está, inclusive falhas, sem tratar a rodada anterior com timeout de Aparência como baseline comprovado.

## 8. Permissões preservadas, remoção do modo de leitura e smoke de voz (D11, D18)

- [x] 8.1 Pedido de Gravação de Tela (D11): frame `push-to-talk.request-screen-recording` no contrato e no `SideChatHost` (`CGRequestScreenCaptureAccess`), pedido pelo Main no primeiro aperto da execução com print ligado e status ≠ `granted`, ao ligar "Enviar print" e na ação de erro antes de abrir o painel; linha de estado "Gravação de Tela" nos Ajustes. Testes primeiro (contrato, adaptador, controlador, Ajustes). Verificar: testes, `generate:partners:check`, build do helper.
- [ ] 8.2 Smoke real da chamada, iniciado somente pelo orquestrador: primeira conexão e réplica, microfone real, áudio de saída e legendas, delegação com print, pausa com tecla presa e espera pendente. Medir conexão e primeiro áudio (R12–R15); sem execução real, registrar "não provado", sem marcar concluído por teste com dublês.
- [ ] 8.3 Remover `read_aloud` e a rota HTTP `say` de `salix_voice`/`comma_web`, com seus testes exclusivos; preservar a ferramenta `im_api.voice.say` da chamada/Router. Verificar: `mix test apps/salix_voice/test apps/comma_web/test` verde, incluindo 4.1–4.3, e busca no escopo confirma a retirada do modo/rota.
- [ ] 8.4 Remover transcritores PTT local/remoto, WAV/`push-to-talk/microphone.ts`, `delivery.ts`, `reply-watcher.ts`, `speaker.ts`, leitura em `live-voice.ts` e seus testes exclusivos; manter apenas o transporte necessário à chamada. Verificar: busca no código PTT e seus consumidores sem referências a transcriber/WAV/delivery/reply-watcher/say/read_aloud; documentar a exclusão da ferramenta do Router e da transcrição de reuniões dessa busca. Não adaptar testes do código retirado para reter o fluxo antigo.

## 9. Verificação integrada e entrega

- [ ] 9.1 Com app iniciado pelo orquestrador, smoke com janela principal fechada: segurar `⌃⌥`, apontar/circular, falar e soltar; conferir Conectando → Ouvindo → Pensando → Falando, nível, legenda, traço e anexos na delegação. Confirmar nenhuma janela/foco tomado, réplica na mesma sessão, interrupção da fala e rascunho preservado. Verificar: evidência visual e Settings nos dois temas em `.tmp/push-to-talk/`; não executar Electron nem `~/.comma-dev/ptt-dev-app.sh`.
- [ ] 9.2 Smoke de erros e ciclo: Input Monitoring negado/concedido, `⌃⌥←` preservado, Microfone negado, Gravação de Tela nunca pedida/negada e print desligado; toque de 0,2 s, bloqueio, troca de conta, `busy`, `plan_limit`, pendência além de 90 s, teto de 10 min e resposta tardia com PTT desligado. Verificar: avisos/ações corretos, nenhuma religação automática e texto tardio na sidebar. Sem app/TCC real, declarar esse limite.
- [ ] 9.3 Medir aperto → conexão, corte inicial da fala, soltura → primeiro áudio, réplica quente e resposta em pausa longa com tecla presa. Registrar evidência e limites de R2/R5/R12–R15 no design; não substituir medidas por estimativas ou testes com dublês.
- [ ] 9.4 Recompilar o bundle de dev neste worktree sem iniciar o app: `pnpm exec tsx scripts/install-dev-protocol-handler.ts` e builds Vite de main/preload/utility/renderer pelo fluxo de `fixes.md`. Preservar `COMMA_MACOS_DEV_SIGN_IDENTITY`, sem assinatura ad hoc por cima; não apagar `.dev-electron`, `.vite` ou `.tmp`; não alterar o runtime do orquestrador. Verificar: saída de build e caminhos dos artefatos, sem declarar voz real ou TCC provados.
- [ ] 9.5 Antes do último commit de implementação, executar `/Users/guilhermevarela/orchestrator.v5/scripts/review-pair.sh --repo /Users/guilhermevarela/Documents/Projetos/SelfHosting/Comma-ptt-integration --base a68d61b0 --out /Users/guilhermevarela/Documents/Projetos/SelfHosting/Comma/.tmp/verify/add-push-to-talk-agent/review-pair/1 --gate`, sem `--agent` ou `--use-credits`; tratar achados pelo fluxo de revisão. Verificar: exit 0 e `summary.md`. Entregar `redesign-delivery.md` no diretório de revisão indicado pelo dono, sem sobrescrever outros relatórios: arquivos, vermelho→verde por tarefa, saídas, SHAs, gate, rebuild e limites (voz real/TCC/latência). Não executar este gate na Fase 1.

## 10. Correções da revisão de código

- [ ] 10.1 F1: preservar o fence de conta com a nova chamada; troca de geração encerra sessão e invalida áudio, contexto, anexos e aviso tardio. Verificar: regressões de 6.1/6.3 falham antes e passam depois.
- [ ] 10.2 F2: preservar a soltura imediata na arquitetura de voz: mutar mesmo com captura/upload pendentes ou ainda conectando, sem continuação desmutar depois. Verificar: regressões de 5.2/5.3/6.1.
- [x] 10.3 F3: continuar o despacho Carbon para IDs de outras instâncias; verificar os dois apertos e a soltura com eventos sintéticos e compilar o helper.
- [x] 10.6 F6: aceitar traços somente no monitor capturado, inclusive se a janela precisar usar outro monitor após uma desconexão.
- [x] 10.7 F7: recusar a reativação do PTT se o atalho salvo conflita com outro atalho, mostrando o motivo nos Ajustes.
- [x] 10.8 F8: ocultar imediatamente a janela que ainda está em fade antes da próxima captura.

## Workflow follow-up

- Fase 1: validar esta change, rodar `pnpm docs:check`, criar `docs(openspec): push-to-talk as a GPT Live call` e parar para conferência do orquestrador.
- Fase 2 somente após autorização: `/openspec-apply-change` + `/test-driven-development`, commits por área em inglês (`feat(voice)`, `feat(desktop)`, `refactor(desktop)`).
- Sem merge, push ou rebase. Arquivar/publicar somente com autorização posterior do dono.
