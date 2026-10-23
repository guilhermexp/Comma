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

Alternativas: `globalShortcut` do Electron não tem evento de soltar. Carbon não pede permissão e já está no helper; continua sendo o caminho para atalhos com tecla comum. Atalhos só de modificadores usam o event tap de D10.

### D2. `PushToTalkController` no Main, como máquina de estados

Estados: `idle → recording → transcribing → sending → awaitingReply (→ speaking) → idle`, mais `error` transitório. Todas as dependências entram pelo construtor (microfone, captura, transcritor, entrega, voz, sobreposição, relógio), o que permite testar cada transição com dublês em `apps/electron/src/main/test/push-to-talk.test.ts`. Regras da spec ficam aqui: 0,3 s mínimo, 120 s máximo, um turno por vez, cancelamento em `powerMonitor` `lock-screen`/`suspend` e em reinício do helper, apagar o WAV em `finally`, espera de resposta de 180 s.

Ordem no aperto: (1) parar leitura em curso; (2) capturar a tela (D3) e iniciar o microfone em paralelo; (3) só depois que a captura terminou, mostrar a sobreposição. Assim a pílula nunca sai no print e a fala não espera a captura.

### D3. Captura com `desktopCapturer` no Main

`desktopCapturer.getSources({ types: ["screen"], thumbnailSize })` com o tamanho físico do monitor do cursor (`screen.getCursorScreenPoint()` → `screen.getDisplayNearestPoint`, casando `display_id`). Saídas:

- **Print do monitor**: reduzido para no máximo 2560 px no lado maior (cabe no limite de 4096 px e ≤10 MB do upload), PNG; se passar de 10 MB, JPEG 85.
- **Recorte**: `nativeImage.crop` na resolução original — a caixa que envolve o traço (com margem de 10%), ou 800×500 pontos centrados no cursor, limitado às bordas do monitor.
- **Traço no print** (revisado): os pontos do traço são convertidos para pixels e desenhados sobre o bitmap BGRA (`toBitmap()` → polilinha com espessura de ~6 px no tamanho do print, cor do companheiro → `createFromBitmap`) antes de codificar o print do monitor e o recorte. Sem dependência nova.
- **Coordenadas**: ponto e caixa do traço convertidos de pontos do Electron para pixels do print enviado (escala do monitor × redução), para o agente citar o mesmo sistema da imagem.

A permissão é verificada com `systemPreferences.getMediaAccessStatus("screen")`. `not-determined` deixa o `desktopCapturer` disparar o pedido do macOS; `denied`/`restricted` seguem sem print (spec). O texto `electron_macos_screen_capture_usage` muda nos três idiomas para cobrir áudio e print.

Alternativas: o daemon do Computer Use só captura o monitor principal, só quando o agente pede e sob outra identidade TCC; ScreenCaptureKit num helper novo seria mais código nativo sem ganho para um print único.

### D4. Cursor companheiro e traço numa janela `push-to-talk-overlay` (revisado)

A mesma janela transparente do monitor do cursor (`focusable: false`, nível `screen-saver`, todos os espaços e tela cheia, `showInactive()`), agora com três elementos desenhados pela tela React (rota `/push-to-talk-overlay`, componente em `packages/ui`, seguindo `~/.agents/skills/impeccable/SKILL.md`):

- **Companheiro**: um marcador junto ao cursor que o acompanha; mostra barras com o nível da voz em `listening`, indicador de espera em `transcribing`/`thinking` e o balão em `speaking`. Referência visual: o triângulo azul do HeyClicky (vídeo do dono, 1:53 e 3:01).
- **Traço**: durante `listening` a janela aceita o mouse (cursor em cruz) e cada arrasto desenha um traço livre, que substitui o anterior; os pontos voltam ao Main por `pushToTalk.setStroke`. O traço some com fade ~1,5 s depois de soltar.
- **Balão**: frase em leitura (voz ligada) ou resposta inteira com rolagem (voz desligada); clicável para abrir a sidebar. Fora do balão, a janela atravessa cliques (`setIgnoreMouseEvents(true, { forward: true })`, com a região do balão interativa).

O Main acompanha o cursor (`screen.getCursorScreenPoint()` a ~60 Hz enquanto a janela está visível), move a janela para o monitor do cursor quando ele troca e envia a posição à tela. O nível vem do RMS dos quadros do microfone, ~20 Hz. Erros aparecem no notch (D9); com o notch desligado, aparecem no balão do companheiro.

Alternativa: `NSPanel` no helper Swift. Rejeitada pelos mesmos motivos de antes (textos traduzidos e ações já existem no app React) e porque a janela já existe.

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
- Cursor: (x, y) px  |  Área do traço: x, y, largura × altura px
- O print leva o traço desenhado por cima; o recorte é a área do traço (ou a região em volta do cursor) em resolução total.
```

A entrega não abre a sidebar nem nenhuma janela (revisão da UX): a resposta aparece no companheiro e no notch, e a conversa fica registrada no chat do agente. Clicar no balão chama `sideChat.open()` normal (com foco, porque foi um clique do usuário). `openWithoutFocus()`, criado na integração, deixa de ser usado e é removido.

Alternativas: injetar no composer da sidebar por evento — usaria o rascunho do usuário; anexar pela chamada de voz (`CallActor`) — exige backend novo e só serve à chamada contínua.

### D7. Resposta lida com `say`

Ao enviar, o controlador guarda `{ conversationId, enviadoEm }`. O gancho `onCanonicalMessagesAppended` (já ligado às notificações) também chama o controlador; a primeira mensagem que passa em `isRouterMessage` nessa conversa e é posterior ao envio encerra a espera. O texto passa por uma função que tira Markdown (títulos, ênfase, links → rótulo, blocos de código → "trecho de código") e é dividido em frases; cada frase vai para `/usr/bin/say` em sequência e, ao começar, vira o texto do balão (`overlay.setCaption`) e o estado `speaking` do notch. O próximo aperto mata o processo e descarta as frases restantes. Com a voz desligada, o balão mostra a resposta inteira por `clamp(palavras × 300 ms, 4 s, 20 s)`.

Alternativas: `speechSynthesis` no renderer da sidebar — exige evento novo para a janela e depende dela estar viva; TTS pago — fora do escopo.

### D8. Ajustes

Campos novos em `commaClientSettingsSchema` (e no patch e nos padrões): `pushToTalkEnabled` (false), `pushToTalkShortcut` (padrão `⌃⌥`, só modificadores — revisado; aceita também tecla + modificador), `pushToTalkSpeakReplies` (true), `pushToTalkSendScreen` (true). O schema do atalho aceita `key: null` com ao menos dois modificadores. O gravador de atalho dos Ajustes salva uma combinação só de modificadores quando todos os modificadores são soltos sem nenhuma tecla comum. O Main lê de `AppPreferencesService` e reage às mudanças registrando/desregistrando o atalho; o conflito é checado junto com o da sidebar e do "Abrir Comma". A seção mostra o estado do Monitoramento de Entrada quando o atalho é só de modificadores.

### D9. Estados de voz no notch

`notchHostScenePayloadSchema` ganha um campo opcional controlado pelo Main, `voice`, no mesmo padrão do `airDrop`: `{ state: "listening" | "transcribing" | "thinking" | "speaking" | "busy" | "error", level?: 0..1, message?: string, action?: { id, label } }`. No `NotchHost`, a cena de voz tem prioridade sobre AirDrop e tarefas enquanto existir; o notch se expande com o texto à esquerda e, à direita, barras animadas pelo `level` na cor do estado (ouvindo verde-água, pensando roxo, falando laranja, erro vermelho — referência: vídeo do dono, 3:00–3:10). Uma ação de erro volta ao Main pelo evento `action` já existente do notch. `NotchService` ganha `setVoice(voice | null)`; `null` devolve a cena anterior. Com o notch desligado (`presentation.visible` falso), `visible()` informa o controlador, que mostra o erro no companheiro.

### D10. Atalho só de modificadores por event tap de leitura

No `SideChatHost`, um `CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, …)` observa `flagsChanged` e `keyDown`:

- **pressed**: quando os modificadores ativos passam a ser exatamente os da combinação (comparando ⌃⌥⇧⌘, ignorando Caps Lock e Fn).
- **released**: quando qualquer modificador da combinação é solto.
- **cancelado**: `keyDown` de qualquer tecla com a combinação pressionada, ou um modificador a mais; o helper envia `push-to-talk.released { cancelled: true }` e o controlador descarta o turno sem erro.
- O tap é reativado em `tapDisabledByTimeout`/`ByUserInput`; nada é engolido (`.listenOnly`).

Permissão: `CGPreflightListenEventAccess()` antes de criar o tap e `CGRequestListenEventAccess()` quando o usuário escolhe um atalho só de modificadores. O helper informa o estado ao Main (`push-to-talk.permission { inputMonitoring: "granted" | "denied" }`) e, enquanto negado, verifica a cada 2 s; ao ser concedido, cria o tap (reiniciando o helper se o macOS exigir), sem reiniciar o Comma. O frame `push-to-talk.shortcut` passa a distinguir "limpar" de "só modificadores" com `{ binding: { keyCode?, modifiers } | null }`.

Alternativas: `NSEvent.addGlobalMonitorForEvents(.flagsChanged)` também exige Monitoramento de Entrada e não vê `keyDown` de forma confiável sem Acessibilidade; um tap ativo (que engole teclas) exigiria Acessibilidade sem ganho, porque `⌃⌥` sozinho não dispara nada nos outros apps.

[INFERENCE] A permissão pode ficar atribuída ao processo responsável (o Comma) ou ao helper `surf.comma.desktop.side-chat`; o smoke confirma qual nome aparece em Ajustes do Sistema, e o texto do botão aponta para o painel certo.

## Risks / Trade-offs

- **R1** — [O modelo do agente não aceita imagem e não há descritor configurado; `fs.read_file` da imagem falha] → a mensagem já traz texto, app e coordenadas; o aviso de privacidade/ajuda dos Ajustes explica que o print exige um modelo com visão. Sem mudança no backend nesta change.
- **R2** — [O início do `MicCaptureHost` leva algumas centenas de ms e corta o começo da fala] → iniciar o microfone em paralelo à captura, no aperto; o notch só mostra "Ouvindo" quando o helper emitir `ready`. Medir no smoke.
- **R3** — [Uma transcrição de reunião em andamento ocupa a fila do `CommaTranscriber`] → a pílula fica em "Transcrevendo" até a fila liberar; limite de 60 s na espera, depois erro "transcrição ocupada".
- **R4** — [No modo de nuvem o helper exige o separador de vozes instalado (`409 cloud_asr_not_ready`)] → tratado como transcrição indisponível, com o mesmo botão para Ajustes → Reunião.
- **R5** — [Resposta lenta: toda pergunta passa pelo Router; no HeyClicky a fala começa 2–3 s depois de soltar] → medir no smoke o tempo entre soltar e "Falando"; se passar muito disso, uma change seguinte avalia um caminho de resposta rápida.
- **R8** — [Com só modificadores, `⌃⌥` seguido de outra tecla dispara captura e microfone por uma fração de segundo antes de cancelar] → o companheiro só aparece depois da captura e o turno cancelado não deixa rastro; o print e o WAV são descartados.
- **R9** — [Campos de senha ativam a entrada segura do macOS e o event tap deixa de ver as teclas] → o atalho fica inativo nesse momento; aceito.
- **R6** — [A voz padrão do sistema pode não ser pt-BR] → aceitar nesta change (segue o ajuste "Conteúdo falado" do macOS); escolha de voz fica para depois.
- **R7** — [Print com dados sensíveis vai ao provedor do modelo] → desligável, padrão explicado nos Ajustes, nada é capturado com o print desligado.

## Migration Plan

Função nova e desligada por padrão; não migra dados. Os campos novos dos ajustes têm padrão, então preferências antigas continuam válidas. Reverter é desligar nos Ajustes ou reverter o commit.
