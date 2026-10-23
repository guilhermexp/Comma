# Tarefas

Comandos de referência (de `clients/`): `pnpm ci:static`, `pnpm test:unit --maxWorkers=4`, `pnpm generate:native-bridge`, `pnpm check:foundation`, `pnpm --dir apps/electron build:native:side-chat`. Testes de Main ficam em `apps/electron/src/main/test/`; da interface, em `packages/app/src/components/**/test/`.

## 1. Contrato e atalho com apertar/soltar (D1)

- [x] 1.1 Escrever primeiro os testes de schema em `packages/chat-contract` para `push-to-talk.shortcut` (host, aceita `null`) e `push-to-talk.pressed`/`push-to-talk.released` (cliente, `frontmostApp` opcional), vendo-os falhar; adicionar os frames e rodar `pnpm generate:native-bridge`. Verificar: testes passam e `pnpm --filter @comma/native-bridge generate:partners:check` fica limpo.
- [x] 1.2 `GlobalHotKey.swift` com `onReleased` (`kEventHotKeyReleased`) e segunda instância no `EdgeChatController`/`SideChatCommandServer` que emite `push-to-talk.pressed` (com `NSWorkspace.frontmostApplication`) e `push-to-talk.released`, sem tocar no `toggle()` da sidebar. Verificar: `pnpm --dir apps/electron build:native:side-chat` compila.
- [x] 1.3 Em `native-side-chat.ts`, registro/desregistro do atalho de falar com resposta, reenvio após reinício do helper e callbacks `onPushToTalkPressed/Released` e `onPushToTalkHelperRestarted`, com teste primeiro em `native-side-chat*.test.ts` usando uma fixture `side-chat-shortcut-*-host.cjs` que emite os frames novos. Verificar: testes passam.

## 2. Ajustes (D8)

- [x] 2.1 Campos `pushToTalkEnabled`, `pushToTalkShortcut`, `pushToTalkSpeakReplies`, `pushToTalkSendScreen` no `commaClientSettingsSchema`, no patch e nos padrões; persistência em `app-preferences.ts`. Teste primeiro em `app-preferences.test.ts` (padrões, merge, ida e volta) e atualizar `client-control-api.test.ts`. Verificar: testes passam.
- [x] 2.2 Conflito do atalho de falar com o da sidebar e o do "Abrir Comma" em `sideChatShortcutConflict.ts`/`commaAppShortcuts.tsx`, com teste primeiro em `sideChatShortcutConflict.test.ts`. Verificar: teste passa.
- [x] 2.3 Seção "Falar com o agente" em `AppSettingsRoute.tsx` seguindo `~/.agents/skills/impeccable/SKILL.md`: liga/desliga (indisponível com a sidebar desligada, com o motivo), atalho, resposta falada, envio do print e aviso de privacidade; textos em `en`, `pt-BR`, `zh-CN`. Teste primeiro em `AppSettingsRoute.test.tsx` para o estado indisponível e o conflito. Verificar: testes e `pnpm i18n:check` passam; print da seção nos dois temas em `.tmp/push-to-talk/`.

## 3. Captura de tela (D3)

- [x] 3.1 Módulo de captura no Main com `desktopCapturer` (monitor do cursor, redução a 2560 px, PNG ou JPEG ≤10 MB, recorte da área ou de 800×500 pt em volta do cursor, conversão de pontos para pixels do print, estados de permissão). Teste primeiro com dublês de `desktopCapturer`/`screen`/`nativeImage` cobrindo monitor secundário com escala 2×, área perto da borda, permissão negada e limite de 10 MB. Verificar: testes passam.
- [x] 3.2 Atualizar `electron_macos_screen_capture_usage` nos três idiomas para cobrir áudio e print enviado ao agente. Verificar: `macos-info-plist-strings.test.ts` e `pnpm i18n:check` passam.

## 4. Transcrição (D5)

- [x] 4.1 Cliente do `CommaTranscriber` para um WAV curto (`/v1/audio/transcriptions`, `response_format=json`) exposto pelo `LocalBackendController`, com teste primeiro usando `test/fixtures/fake-comma-transcriber.mjs` (sucesso, vazio, `409 cloud_asr_not_ready`, `502 cloud_asr_failed`, fallback). Verificar: testes passam.
- [x] 4.2 Extrair o parser SSE de `modules/audio-capture/transcription.ts` para função compartilhada e criar a implementação remota (m4a pelo `HelperRecordingEncoder` → `/v1/comma/me/recordings/transcribe`, sem prefixos `[HH:MM:SS] Speaker N:`). Teste primeiro do parser e da limpeza de prefixos; `recording-transcription.test.ts` continua passando. Verificar: testes passam.

## 5. Entrega e resposta falada (D6, D7)

- [x] 5.1 `ChatCoordinator.sendDetachedMessage(target, text, attachments)` com upload pelo `uploadGroupFile` e a seção `Attached files in your workspace:` no formato do composer, sem usar o rascunho. Teste primeiro em `chat-coordinator.test.ts`: rascunho intacto, anexos citados, falha de upload não envia mensagem. Verificar: testes passam.
- [x] 5.2 Função que monta o texto do turno (transcrição + bloco de contexto com app, tamanho do print, cursor e área) e função que tira Markdown para leitura, com testes primeiro de casos sem print, sem app e com área. Verificar: testes passam.
- [x] 5.3 Leitor com `/usr/bin/say` interrompível e espera da resposta pelo `onCanonicalMessagesAppended` + `isRouterMessage` (só a conversa e o turno do atalho, primeira resposta, 180 s), com teste primeiro usando relógio falso e processo falso. Verificar: testes passam.

## 6. Controlador do turno e sobreposição (D2, D4)

- [x] 6.1 `PushToTalkController` com a máquina de estados e todas as regras da spec (0,3 s, 120 s, um turno por vez, cancelamento em `lock-screen`/`suspend`/reinício do helper, WAV apagado em `finally`, transcrição indisponível no aperto, microfone negado, print desligado/negado, transcrição vazia, falha de envio). Teste primeiro em `push-to-talk.test.ts` com dublês de todas as dependências, um caso por cenário da spec. Verificar: testes passam.
- [x] 6.2 Janela `push-to-talk-overlay` (registro do papel em `feature-surfaces.ts`, `managed-window.ts`, `window-options.ts`, `modules/ipc/index.ts`, `preload/native-bridge.ts`, capacidades por papel, `renderComma.tsx`), evento de estado e capacidade `pushToTalk.setRegion`; tela React com arrasto e pílula seguindo `~/.agents/skills/impeccable/SKILL.md`. Testes primeiro: `window-options.test.ts` (sem foco, nível, todos os espaços) e teste jsdom da tela (arrasto gera área, nova área substitui, pílula por estado). Atualizar `e2e/window-census.spec.ts`. Verificar: testes passam.
- [x] 6.3 Ligar tudo em `electron-main.module.ts`/`index.ts`: controlador criado com os ajustes, reage a mudanças, desregistra o atalho com a sidebar desligada, abre a sidebar após o envio sem tirar o foco do app em uso. Verificar: `pnpm ci:static` e `pnpm test:unit --maxWorkers=4` passam (falhas antigas conhecidas listadas à parte).

## 7. Revisão da UX: atalho ⌃⌥, notch, companheiro, traço (D4, D6–D10)

- [ ] 7.1 Contrato do atalho: `push-to-talk.shortcut { binding: { keyCode?, modifiers } | null }`, `push-to-talk.released { cancelled }`, `push-to-talk.permission { inputMonitoring }` e o pedido de permissão; schema dos ajustes aceita `key: null` com ≥2 modificadores e padrão `⌃⌥`. Testes de schema primeiro; `pnpm generate:native-bridge`. Verificar: testes e `generate:partners:check` passam.
- [ ] 7.2 Event tap de leitura no `SideChatHost` (D10): pressed/released/cancelled, modificador a mais não dispara, reativação após timeout, estado e pedido do Monitoramento de Entrada com nova checagem a cada 2 s; Carbon continua para tecla comum. Verificar: `build:native:side-chat` compila; fixture do helper cobre os frames novos.
- [ ] 7.3 Adaptador em `native-side-chat.ts`/`native-hotkey.ts` para o contrato novo (`register` devolve o estado da permissão, `onReleased({ cancelled })`, `onPermission`), com teste primeiro na fixture. Verificar: testes passam.
- [ ] 7.4 Ajustes: gravador de atalho aceita só modificadores, conflitos consideram combinações só de modificadores, linha de estado do Monitoramento de Entrada com botão para os Ajustes do Sistema; textos nos três idiomas. Testes primeiro (`AppSettingsRoute.test.tsx`, `sideChatShortcutConflict.test.ts`, teste do gravador). Verificar: testes, `pnpm i18n:check` e prints da seção em `.tmp/push-to-talk/`.
- [ ] 7.5 Cena de voz no notch (D9): campo `voice` no payload, view no `NotchHost` com estado, barras de nível e cor por estado, ação de erro; `NotchService.setVoice` e `visible()`. Testes primeiro em `notch.test.ts` e no contrato. Verificar: testes, `generate:partners:check`, build do `NotchHost` e prints da cena em cada estado em `.tmp/push-to-talk/`.
- [ ] 7.6 Tela da sobreposição (D4): companheiro que segue o cursor com nível, espera e balão; traço livre que substitui o anterior e some com fade; balão clicável; seguindo `~/.agents/skills/impeccable/SKILL.md`. Testes jsdom primeiro (traço, balão, estados). Verificar: testes e prints em `.tmp/push-to-talk/`.
- [ ] 7.7 Janela no Main (D4): acompanhamento do cursor e troca de monitor, região interativa do balão, `setLevel`/`setCaption`/`onStroke`/`onCaptionClick`. Teste primeiro em `push-to-talk-overlay.test.ts`. Verificar: testes passam.
- [x] 7.8 Captura com traço (D3): pontos do traço → caixa, recorte com margem e traço desenhado no bitmap do print e do recorte. Teste primeiro em `push-to-talk-screen.test.ts` (traço em monitor 2×, traço na borda, pixels do traço presentes no print). Verificar: testes passam.
- [ ] 7.9 Controlador e voz (D2, D6, D7): estados `thinking`/`speaking` para o notch e o companheiro, nível do microfone, `released { cancelled }` descarta sem erro, leitura frase por frase com legenda, balão por tempo de leitura com voz desligada, clique no balão abre a sidebar, entrega sem abrir a sidebar (remover `openWithoutFocus`), erros no companheiro com o notch desligado. Testes primeiro em `push-to-talk.test.ts`, `push-to-talk-reply.test.ts` e `push-to-talk-delivery.test.ts`. Verificar: testes passam.
- [ ] 7.10 Integração: ligar a cena de voz do notch e o contrato novo do atalho no Main; `pnpm ci:static`, `pnpm test:unit --maxWorkers=4`, `pnpm check:foundation` e `pnpm --dir apps/electron build` passam.

## 8. Verificação no Mac real

- [ ] 8.1 Smoke no app de dev (`COMMA_BUILD_FLAVOR=dev`, perfil `~/.comma-dev/profile`) com a janela principal fechada: segurar `⌃⌥` sobre um app, apontar e depois circular algo, falar em pt-BR, soltar; conferir notch (Ouvindo → Transcrevendo → Pensando → Falando), companheiro com nível e balão, traço no print, mensagem com texto, contexto e dois anexos na conversa, nenhuma janela aberta, resposta lida e interrompida por novo aperto. Verificar: gravação de tela e prints em `.tmp/push-to-talk/` e a mensagem enviada lida via chat.
- [ ] 8.2 Smoke dos caminhos de erro: Monitoramento de Entrada negado e concedido depois, `⌃⌥←` em outro app (cancela e o app recebe a tecla), Gravação de Tela negada, transcrição indisponível, toque de 0,2 s, bloqueio da tela durante a gravação, rascunho da sidebar preservado. Verificar: prints de cada caso em `.tmp/push-to-talk/`.
- [ ] 8.3 Medir no smoke o corte do início da fala (R2) e o tempo entre soltar e "Falando" (R5); registrar no `design.md`. Verificar: seção de riscos atualizada.

## Workflow follow-up

- Revisão com `/requesting-code-review`, depois `/openspec-archive-change`, `/sync` e `/cleanup`.
- Publicação em release só quando o dono pedir.
