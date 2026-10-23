# Design

## Context

Motivação em `proposal.md`; comportamento em `specs/agent-push-to-talk/spec.md`. O que existe e foi conferido no código (caminhos relativos a `clients/`):

- **Atalho global**: `apps/electron/native/macos/SideChatHost/Comma/GlobalHotKey.swift` registra com Carbon `RegisterEventHotKey` e trata só `kEventHotKeyPressed`; `EdgeChatController.swift:192-225` liga ao `toggle()` da sidebar. Main conversa com o helper por JSONL (`apps/electron/src/main/native-side-chat.ts`, `#handleClientFrame` :909); os frames estão em `packages/chat-contract/src/index.ts` (`sideChatHostFrameSchema`, `sideChatClientFrameSchema`) e o Swift é gerado por `pnpm --dir clients generate:native-bridge`.
- **Microfone**: `HelperMicrophoneCapture` (`apps/electron/src/main/modules/audio-capture/microphone.ts:62`) roda o `MicCaptureHost` e entrega Float32; `WavSink` (`audio-capture/wav.ts`) grava WAV 16 kHz mono; `HelperRecordingEncoder` (`encoder.ts:13`) converte para m4a.
- **Transcrição**: no modo local, o `CommaTranscriber serve` expõe `POST /v1/audio/transcriptions` (multipart, bearer) e escolhe Local/Groq/compatível com fallback; Main já tem `transcriberUrl`/`transcriberToken` (`local-backend/service.ts:165,171`). No modo remoto, o backend tem `POST /v1/comma/me/recordings/transcribe` (m4a, resposta SSE), usado em `modules/audio-capture/transcription.ts:186`. `MeetingTranscriptionService.state()` diz se a transcrição está pronta.
- **Chat**: o `ChatCoordinator` vive no Main (`electron-main.module.ts:~950`); `resolveWorkspaceChat()` dá a conversa da sidebar; `sendDetachedMessage(target, text)` (`SendIntents.ts:83`) envia texto sem rascunho; anexos só passam pelo rascunho (`DraftEditor.claimDraftOwner`), que falha se a sidebar tiver rascunho. O upload é `api.uploadGroupFile` → `POST /v1/comma/groups/:group_id/files` (png/jpg, ≤10 MB, ≤4096 px por lado), e o composer cita anexos no texto com `- nome (workspace file: /uploads/…)` (`components/chat/model/protocol.ts:95-98`). `onCanonicalMessagesAppended` (`hostContract.ts:43`) avisa só mensagens já confirmadas do servidor; `isRouterMessage` (`modules/message-notifications.ts:60`) reconhece a resposta do agente.
- **Sobreposição**: `meeting-recorder-window.ts` é a referência de janela transparente sempre no topo com clique atravessando; o registro de um novo papel de janela passa por `feature-surfaces.ts`, `managed-window.ts`, `window-options.ts`, `modules/ipc/index.ts`, `preload/native-bridge.ts`, a lista de capacidades por papel em `electron-main.module.ts:~1837` e `renderComma.tsx`.
- **Captura de tela**: não existe no app Electron. A Gravação de Tela hoje pertence ao "Comma Computer Use.app", outra identidade TCC. O texto `NSScreenCaptureUsageDescription` (`scripts/macos-info-plist-strings.ts:12`, chave `electron_macos_screen_capture_usage`) fala só de áudio.
- **Ajustes**: `commaClientSettingsSchema` (`packages/native-bridge/src/capability-leaves.ts:1198`), persistido em `main/app-preferences.ts`; tela em `packages/app/src/components/AppSettingsRoute.tsx` (seção `keyboard.commands` com o controle `type:"shortcut"`, conflitos em `shortcuts/sideChatShortcutConflict.ts`).

## Goals / Non-Goals

**Goals:**

- Um único dono do turno no Main, testável com dublês, que liga atalho → gravação → captura → transcrição → envio → leitura.
- Reaproveitar helper, transcrição, upload e coordenador de chat existentes; nenhuma mudança no backend.

**Non-Goals:**

- Streaming de transcrição enquanto o usuário fala.
- Mudar o comportamento do atalho da sidebar ou do "Abrir Comma".
- Testes Swift para o SideChatHost (o projeto não tem alvo de teste; a verificação dele é o smoke real).

## Decisions

### D1. Atalho: segundo hotkey Carbon no helper da sidebar, com apertar e soltar

`GlobalHotKey` ganha `onReleased` e registra também `kEventHotKeyReleased`. O `EdgeChatController` passa a ter uma segunda instância, com id próprio, só para o falar-com-o-agente. Novos frames:

- Main → helper: `push-to-talk.shortcut` `{ keyCode, modifiers } | null` (reusa `sideChatShortcutRegistrationInputSchema`; `null` desregistra), com resposta `command.result` e reenvio após reinício do helper, como o `side-chat.shortcut`.
- Helper → Main: `push-to-talk.pressed` `{ frontmostApp: { name, bundleId } | null }` e `push-to-talk.released` `{}`. O app em primeiro plano vem de `NSWorkspace.shared.frontmostApplication` no instante do aperto, sem permissão.

Alternativas: `globalShortcut` do Electron não tem evento de soltar; atalho só de modificadores exige `CGEventTap`/monitor global e Monitoramento de Entrada (fora do escopo). Carbon não pede permissão e já está no helper.

### D2. `PushToTalkController` no Main, como máquina de estados

Estados: `idle → recording → transcribing → sending → awaitingReply (→ speaking) → idle`, mais `error` transitório. Todas as dependências entram pelo construtor (microfone, captura, transcritor, entrega, voz, sobreposição, relógio), o que permite testar cada transição com dublês em `apps/electron/src/main/test/push-to-talk.test.ts`. Regras da spec ficam aqui: 0,3 s mínimo, 120 s máximo, um turno por vez, cancelamento em `powerMonitor` `lock-screen`/`suspend` e em reinício do helper, apagar o WAV em `finally`, espera de resposta de 180 s.

Ordem no aperto: (1) parar leitura em curso; (2) capturar a tela (D3) e iniciar o microfone em paralelo; (3) só depois que a captura terminou, mostrar a sobreposição. Assim a pílula nunca sai no print e a fala não espera a captura.

### D3. Captura com `desktopCapturer` no Main

`desktopCapturer.getSources({ types: ["screen"], thumbnailSize })` com o tamanho físico do monitor do cursor (`screen.getCursorScreenPoint()` → `screen.getDisplayNearestPoint`, casando `display_id`). Saídas:

- **Print do monitor**: reduzido para no máximo 2560 px no lado maior (cabe no limite de 4096 px e ≤10 MB do upload), PNG; se passar de 10 MB, JPEG 85.
- **Recorte**: `nativeImage.crop` na resolução original — a área marcada, ou 800×500 pontos centrados no cursor, limitado às bordas do monitor.
- **Coordenadas**: ponto e área convertidos de pontos do Electron para pixels do print enviado (escala do monitor × redução), para o agente citar o mesmo sistema da imagem.

A permissão é verificada com `systemPreferences.getMediaAccessStatus("screen")`. `not-determined` deixa o `desktopCapturer` disparar o pedido do macOS; `denied`/`restricted` seguem sem print (spec). O texto `electron_macos_screen_capture_usage` muda nos três idiomas para cobrir áudio e print.

Alternativas: o daemon do Computer Use só captura o monitor principal, só quando o agente pede e sob outra identidade TCC; ScreenCaptureKit num helper novo seria mais código nativo sem ganho para um print único.

### D4. Marcação de área e pílula numa janela `push-to-talk-overlay`

Uma janela transparente por turno, no monitor do cursor, com as opções do `meeting-recorder-window` mas do tamanho do monitor: `focusable: false`, `alwaysOnTop` em nível `screen-saver`, visível em todos os espaços e em tela cheia, `showInactive()`. Durante `recording` ela aceita o mouse (cursor em cruz) para o arrasto; em `transcribing` passa a `setIgnoreMouseEvents(true)` e mostra só a pílula; ao enviar ou cancelar, é escondida. A janela é criada uma vez e reutilizada. A tela (rota `/push-to-talk-overlay`, componente em `packages/app`) recebe o estado por um evento nativo e devolve a área por uma capacidade `pushToTalk.setRegion`. Ela segue `~/.agents/skills/impeccable/SKILL.md`.

Alternativa: `NSPanel` no helper Swift. Rejeitada porque a pílula precisa de texto traduzido e botões de ação que já existem no app React, e a janela Electron tem precedente pronto.

### D5. Transcrição por uma interface com duas implementações

`PushToTalkTranscriber.transcribe(wavPath): Promise<{ text, fallback? }>`:

- **Modo local**: multipart para o `CommaTranscriber` (`/v1/audio/transcriptions`, `response_format=json`) com o WAV direto. Um cliente novo exposto pelo `LocalBackendController`.
- **Modo remoto**: converte para m4a com o `HelperRecordingEncoder` e chama `/v1/comma/me/recordings/transcribe`, reaproveitando o parser SSE de `transcription.ts` (extraído para função compartilhada) e removendo os prefixos `[HH:MM:SS] Speaker N:`.

Antes de gravar, `MeetingTranscriptionService.state()` decide se a transcrição está pronta; se não, a pílula mostra o erro já no aperto, sem gravar. Erros `local_asr_model_not_installed` e `cloud_asr_failed` viram mensagens da pílula.

### D6. Entrega: novo envio com anexos que não usa o rascunho

`ChatCoordinator` ganha `sendDetachedMessage(target, text, attachments)`: faz `uploadGroupFile` de cada imagem e envia o texto com a seção `Attached files in your workspace:` no formato do composer, sem `claimDraftOwner`. Texto enviado:

```
<transcrição>

Contexto da tela (capturado quando apertei o atalho):
- App em primeiro plano: <nome>
- Print do monitor: <largura>×<altura> px
- Cursor: (x, y) px  |  Área marcada: x, y, largura × altura px
- O recorte é a área marcada (ou a região em volta do cursor) em resolução total.
```

Depois, `chat.presentInSideChat` e `sideChat.open()` mostram a conversa. Se `open()` ativar o app, usa-se o caminho de apresentação sem foco que a sidebar já usa para o gesto de borda (a verificar na tarefa 6.3).

Alternativas: injetar no composer da sidebar por evento — usaria o rascunho do usuário; anexar pela chamada de voz (`CallActor`) — exige backend novo e só serve à chamada contínua.

### D7. Resposta lida com `say`

Ao enviar, o controlador guarda `{ conversationId, enviadoEm }`. O gancho `onCanonicalMessagesAppended` (já ligado às notificações) também chama o controlador; a primeira mensagem que passa em `isRouterMessage` nessa conversa e é posterior ao envio encerra a espera. O texto passa por uma função que tira Markdown (títulos, ênfase, links → rótulo, blocos de código → "trecho de código") e vai para `/usr/bin/say` (voz padrão do sistema), num processo que o próximo aperto mata. A resposta aparece na sidebar normalmente.

Alternativas: `speechSynthesis` no renderer da sidebar — exige evento novo para a janela e depende dela estar viva; TTS pago — fora do escopo.

### D8. Ajustes

Campos novos em `commaClientSettingsSchema` (e no patch e nos padrões): `pushToTalkEnabled` (false), `pushToTalkShortcut` (`⌃⌥Espaço`), `pushToTalkSpeakReplies` (true), `pushToTalkSendScreen` (true). O Main lê de `AppPreferencesService` e reage às mudanças registrando/desregistrando o atalho; o conflito é checado junto com o da sidebar e do "Abrir Comma". A seção fica em Ajustes, perto dos atalhos, com o aviso de privacidade.

## Risks / Trade-offs

- **R1** — [O modelo do agente não aceita imagem e não há descritor configurado; `fs.read_file` da imagem falha] → a mensagem já traz texto, app e coordenadas; o aviso de privacidade/ajuda dos Ajustes explica que o print exige um modelo com visão. Sem mudança no backend nesta change.
- **R2** — [O início do `MicCaptureHost` leva algumas centenas de ms e corta o começo da fala] → iniciar o microfone em paralelo à captura, no aperto; a pílula só mostra "Ouvindo" quando o helper emitir `ready`. Medir no smoke.
- **R3** — [Uma transcrição de reunião em andamento ocupa a fila do `CommaTranscriber`] → a pílula fica em "Transcrevendo" até a fila liberar; limite de 60 s na espera, depois erro "transcrição ocupada".
- **R4** — [No modo de nuvem o helper exige o separador de vozes instalado (`409 cloud_asr_not_ready`)] → tratado como transcrição indisponível, com o mesmo botão para Ajustes → Reunião.
- **R5** — [`sideChat.open()` pode ativar o Comma e tirar o foco do app em uso] → verificar no smoke; se ativar, apresentar a sidebar pelo caminho sem foco.
- **R6** — [A voz padrão do sistema pode não ser pt-BR] → aceitar nesta change (segue o ajuste "Conteúdo falado" do macOS); escolha de voz fica para depois.
- **R7** — [Print com dados sensíveis vai ao provedor do modelo] → desligável, padrão explicado nos Ajustes, nada é capturado com o print desligado.

## Migration Plan

Função nova e desligada por padrão; não migra dados. Os campos novos dos ajustes têm padrão, então preferências antigas continuam válidas. Reverter é desligar nos Ajustes ou reverter o commit.
