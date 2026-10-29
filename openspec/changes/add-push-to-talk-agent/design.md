# Design

## Context

Motivação em `proposal.md`; contrato em `specs/agent-push-to-talk/spec.md`. Esta revisão substitui o fluxo gravar → transcrever → enviar texto → ler por uma chamada GPT Live, conforme o desenho aprovado pelo dono em 2026-10-28.

**Revisão V1–V5 — decisão explícita do dono em 2026-10-29:** manter GPT Live e Router por baixo, mas apresentar turnos de fala por atalho, não uma ligação. PTT não publica início/fim de chamada na conversa. Capta desde o aperto com buffer local antes da conexão; mostra "Ouvindo". O gesto passa a controlar a reprodução: aperto silencia, soltura restaura, sem autoridade de legenda. A decisão substitui a reprodução sempre ao vivo aprovada em 10.32; não invalida o registro de aprovação posterior à auditoria. A aprovação de encerramento forçado em 10.42 permanece. V5 conserva contexto/print/traço, Router, 90 s/10 min, pendências, resposta tardia, ajustes, permissões, fence e cancelamento.

- **Base preservada**: atalho Carbon/event tap do SideChatHost, cancelamento por tecla extra, captura do monitor do cursor, traço, overlay, notch, pedidos de Monitoramento de Entrada e Gravação de Tela. Não alterar helper Swift nem NotchHost.
- **Chamada existente**: `systems/apps/salix_voice` usa `CallActor`, carrier Electron e `Model.Codex` (`gpt-live-1-codex`), com mídia WebRTC direta entre renderer e serviço e controle por sideband. `VoiceCallControl` é a referência de microfone, SDP/ICE, áudio remoto ao vivo e polling.
- **Delegação existente**: o modelo de voz não tem ferramentas nem visão; o CallActor encaminha a delegação ao Router por `enqueue_group_router_im_provider_message`, que já aceita `attachments:`. O Router tem o contexto e as ferramentas do workspace.
- **Controle existente**: início, eventos e hangup passam por `systems/apps/comma_web`; operações da chamada têm escopo `{tenant, group, user}`. Só uma chamada pode ocupar o Group.
- **Janela existente**: `push-to-talk-voice` hospeda o peer de leitura com faixa sintética. Será convertida para microfone real; hoje a permissão de mídia do Main cobre apenas a janela principal.
- **Sem entidade nova**: chamada, delegação e arquivos existentes representam o fluxo. O CallActor é dono do contexto pendente da chamada. Mutações de conversa permanecem por `ConversationServer -> ConversationActor`.

## Goals / Non-Goals

**Goals:**

- Um dono no Main para o gesto e a sessão: aperto → conectar/desmutar → mutar → resposta/delegação → réplica ou encerramento.
- Reutilizar a chamada GPT Live e o upload existentes; acrescentar modo e contexto no backend sem duplicar o Router ou a autoridade da conversa.

**Non-Goals:**

- ASR separado, WAV ou transcrição integral persistida; TTS alternativo; imagem direta no modelo de voz; inventar controle de VAD não exposto pelo protocolo.
- Mudar o comportamento do atalho da sidebar ou do "Abrir Comma".
- Testes Swift para o SideChatHost (o projeto não tem alvo de teste; a verificação dele é o smoke real).

## Decisions

### D1. Atalho: segundo hotkey Carbon no helper da sidebar, com apertar e soltar

`GlobalHotKey` ganha `onReleased` e registra também `kEventHotKeyReleased`. O `EdgeChatController` passa a ter uma segunda instância, com id próprio, só para o falar-com-o-agente. Novos frames:

- Main → helper: `push-to-talk.shortcut` `{ keyCode, modifiers } | null` (reusa `sideChatShortcutRegistrationInputSchema`; `null` desregistra), com resposta `command.result` e reenvio após reinício do helper, como o `side-chat.shortcut`.
- Helper → Main: `push-to-talk.pressed` `{ frontmostApp: { name, bundleId } | null }` e `push-to-talk.released` `{}`. O app em primeiro plano vem de `NSWorkspace.shared.frontmostApplication` no instante do aperto, sem permissão.

Alternativas: `globalShortcut` do Electron não tem evento de soltar. Carbon não pede permissão e já está no helper; continua sendo o caminho para atalhos com tecla comum. Atalhos só de modificadores usam o event tap de D10.

Cada handler devolve `eventNotHandledErr` quando o `EventHotKeyID` pertence à outra instância. Carbon continua o despacho no mesmo target até encontrar o dono do ID; só esse handler executa a ação e devolve `noErr`. O smoke com eventos Carbon sintéticos cobre os dois apertos e a soltura do PTT. Teclas físicas e TCC continuam dependendo do smoke no app.

### D2. `PushToTalkController` no Main, como máquina de estados

Estados visíveis: `listening → thinking → speaking → idle`, mais `ready` para resposta tardia e `error` transitório. O aperto projeta `listening` imediatamente, sem estado "Conectando", preservando a barreira de captura para não incluir a sobreposição no print. O nível vem do microfone local, mesmo antes da conexão. `thinking` vale depois de soltar e durante delegação; legendas podem chegar durante o gesto, mas o áudio fica inaudível. `idle` pode conter uma sessão quente, mutada e sem UI.

A reprodução depende somente do gesto no renderer. Eventos de mídia continuam descrevendo a atividade remota para o ciclo da sessão; nem caption, RMS ou contador sintético de turno autoriza reprodução. Novo aperto limpa a legenda e silencia imediatamente; a soltura restaura a mídia corrente, sem replay de saída consumida enquanto mutada.

Dependências injetadas: sessão de voz, captura/upload/contexto, notch, companheiro, relógio e geração de conta. Regras: mínimo de 0,3 s, captação por aperto limitada a 120 s, réplica por 90 s após a resposta, retenção durante delegação e teto absoluto de 10 min para a sessão. Não há espera de mensagem transcrita ou remoção de WAV.

No aperto: limpar a legenda e ocultar a sobreposição anterior inclusive no fade; iniciar sinalização, admissão do contexto, captura local do microfone e captura da tela em paralelo. O renderer silencia a reprodução remota imediatamente. A entrada local aguarda conexão, ACK de controle e confirmação de 0,3 s num buffer limitado; não espera captura/upload. Depois envia o início em ordem e continua ao vivo. Mostrar a sobreposição depois da captura. Soltar ou atingir 120 s muta o microfone e restaura a reprodução imediatamente, sem esperar contexto ou legenda. ACK tardio pode liberar o buffer de um gesto válido já solto, mas nunca reabrir a captação. Cancelamento/falha, novo contexto ou conta descarta a entrada antiga ainda não enviada. Preservar o fence de F2.

Mudança de geração de conta encerra a chamada, invalida o turno e suas continuações, descarta contexto/anexos pendentes e oculta a UI (F1). Operações já admitidas mantêm o fence da credencial original; nenhuma continuação adquire a conta nova. Bloqueio, suspensão ou reinício do helper encerram a captação e a chamada quando a soltura não puder ser garantida. Desligar PTT encerra a chamada; resposta pendente segue a política de D16, sem reabrir o microfone.

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

- **Companheiro**: marcador junto ao cursor, com barras do microfone em `listening`, espera em `thinking`, legenda em `speaking` e aviso em `ready`. Não há apresentação de conexão. Mantém a referência visual já implementada do HeyClicky.
- **Traço**: durante `listening` a janela aceita o mouse (cursor em cruz) e cada arrasto desenha um traço livre, que substitui o anterior; os pontos voltam ao Main por `pushToTalk.setStroke`. O traço some com fade ~1,5 s depois de soltar.
- **Balão**: frase falada pelo modelo de voz ou "Resposta pronta" com a resposta tardia do Router; clicar abre a sidebar. O clique em `ready`, pelo balão ou pela ação do notch, reconhece o aviso e limpa as duas apresentações. Um clique durante fala não encerra a mídia nem oculta a legenda. Fora da região interativa, a janela deixa os cliques atravessarem.

O Main acompanha o cursor a ~60 Hz somente enquanto a janela está visível. O nível vem do `AnalyserNode` do renderer de voz, enviado ao Main por IPC a ~20 Hz. Há uma única sessão e uma sobreposição ativa por app; não há timer por delegação. Erros aparecem exclusivamente no notch visível (D9); ocultar o companheiro anterior. Com notch desligado, o companheiro mostra o erro e a ação.

O monitor capturado no início continua sendo o único espaço válido para o traço. Ao mover o cursor para outro monitor, o companheiro acompanha o cursor e o traço anterior é limpo, mas novos traços nesse monitor são recusados. Ao voltar ao monitor capturado, o desenho volta a ser aceito. Não se remapeiam coordenadas de B sobre o print de A: isso apontaria para conteúdo diferente do que o usuário marcou.

Alternativa: `NSPanel` no helper Swift. Rejeitada pelos mesmos motivos de antes (textos traduzidos e ações já existem no app React) e porque a janela já existe.

### D8. Ajustes

Campos preservados em `commaClientSettingsSchema`, patch e padrões: `pushToTalkEnabled` (false), `pushToTalkShortcut` (`⌃⌥`) e `pushToTalkSendScreen` (true). Remover `pushToTalkSpeakReplies` e sua UI/i18n: a voz é inerente à chamada. PTT não consulta a prontidão nem o provedor de Reunião. O schema do atalho aceita `key: null` com ao menos dois modificadores; o gravador salva a combinação ao soltar todos os modificadores sem tecla comum. O Main reage às preferências registrando/desregistrando o atalho. A seção conserva os estados de Monitoramento de Entrada e Gravação de Tela e explica os destinos do áudio e dos prints.

Ao religar a função, os Ajustes revalidam também a combinação salva contra os atalhos globais e os atalhos do app. Um conflito mantém a função desligada e mostra o motivo existente, em vez de persistir uma configuração que não pode ser registrada.

### D9. Estados de voz no notch

Usar a cena de voz e as ações já existentes do notch, sem alterar helper Swift/NotchHost. O Main projeta "Ouvindo" desde o aperto, "Pensando", "Falando", "Resposta pronta" e erros. Remover a projeção/texto "Conectando". A cena de voz conserva sua prioridade; ao limpar, restaura a anterior. Com notch desligado, o companheiro apresenta aviso e ação. Sessão quente em `idle` não mantém UI.

### D10. Atalho só de modificadores por event tap de leitura

No `SideChatHost`, um `CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, …)` observa `flagsChanged` e `keyDown`:

- **pressed**: quando os modificadores ativos passam a ser exatamente os da combinação (comparando ⌃⌥⇧⌘, ignorando Caps Lock e Fn).
- **released**: quando qualquer modificador da combinação é solto.
- **cancelado**: `keyDown` de qualquer tecla com a combinação pressionada, ou um modificador a mais; o helper envia `push-to-talk.released { cancelled: true }` e o controlador descarta o turno sem erro.
- O tap é reativado em `tapDisabledByTimeout`/`ByUserInput`; nada é engolido (`.listenOnly`).

Permissão: `CGPreflightListenEventAccess()` antes de criar o tap e `CGRequestListenEventAccess()` quando o usuário escolhe um atalho só de modificadores. O helper informa o estado ao Main (`push-to-talk.permission { inputMonitoring: "granted" | "denied" }`) e, enquanto negado, verifica a cada 2 s; ao ser concedido, cria o tap (reiniciando o helper se o macOS exigir), sem reiniciar o Comma. O frame `push-to-talk.shortcut` passa a distinguir "limpar" de "só modificadores" com `{ binding: { keyCode?, modifiers } | null }`.

Alternativas: `NSEvent.addGlobalMonitorForEvents(.flagsChanged)` também exige Monitoramento de Entrada e não vê `keyDown` de forma confiável sem Acessibilidade; um tap ativo (que engole teclas) exigiria Acessibilidade sem ganho, porque `⌃⌥` sozinho não dispara nada nos outros apps.

[INFERENCE] A permissão pode ficar atribuída ao processo responsável (o Comma) ou ao helper `surf.comma.desktop.side-chat`; o smoke confirma qual nome aparece em Ajustes do Sistema, e o texto do botão aponta para o painel certo.

### D11. Pedido de Gravação de Tela pelo helper

No macOS 15+, `systemPreferences.getMediaAccessStatus("screen")` responde `denied` também quando o Comma nunca pediu a permissão (medido: um Electron com a identidade do Comma Dev responde `denied` antes de qualquer pedido). Pular a captura nesse estado deixava o Comma fora da lista de Gravação de Tela, sem como o usuário conceder. O `SideChatHost` ganha o frame `push-to-talk.request-screen-recording`, que chama `CGRequestScreenCaptureAccess()`; o TCC atribui o pedido ao Comma (processo responsável), como já acontece com o Monitoramento de Entrada. O Main pede quando: o print está ligado e o status não é `granted` — no primeiro aperto de cada execução, ao ligar "Enviar print" nos Ajustes e na ação de erro "Abrir Ajustes do Sistema" (antes de abrir o painel). Os Ajustes ganham a linha de estado "Gravação de Tela", no mesmo padrão da linha de Monitoramento de Entrada.

### D13. Sessão GPT Live sem aparência de chamada

`POST /v1/comma/workspaces/:id/voice/calls` aceita `mode: "push_to_talk"`. O CallActor usa instruções de turnos de fala por atalho e respostas curtas, sem saudação ou espera do perfil, com delegação ativa. Não publica `voice.call_started` nem `voice.call_ended` como evento/cartão na conversa PTT. A chamada manual mantém esses registros. Preservar uso/minutos e o ingresso canônico: o handoff terminal continua informando ao Router apenas as delegações com ACK conhecido, sem criar registro visual de chamada. Não transforma toda fala/legenda em mensagem persistida.

A mesma exclusão por Group vale para chamada manual e PTT. `busy` (409) mostra "ligação em andamento"; `plan_limit` (429) mostra o limite do plano no notch/companheiro. Sem fallback para ASR, mensagem transcrita ou voz do sistema.

### D14. Microfone real na janela oculta

Usar `getUserMedia({ audio: true })` na janela `push-to-talk-voice` oculta e sem foco. O microfone físico segue o gesto; um grafo WebAudio capta em buffer local limitado e fornece a faixa de `MediaStreamDestination` ao peer. A faixa enviada não recebe fala antes de conexão, admissão do contexto e mínimo de 0,3 s. Replay da entrada retida precede a continuação ao vivo, sem perder a ordem. Atraso na primeira conexão é aceito; a réplica quente não repete a conexão. Buffer é limitado pelo gesto de 120 s e pelos prazos de admissão/sessão. Toque curto descarta tudo sem envio. Encerramento, falha, contexto novo e conta removem buffer, fontes agendadas e faixas.

O contrato nativo separa `listening` (gesto/captação e mute remoto), `qualified` (mínimo de 0,3 s confirmado pelo relógio do Main), `admitted` (ACK do controle) e `contextId` (correlação transitória já existente; `null` invalida). O renderer não mede outra duração: início frio ou IPC atrasado não perdem gesto válido nem promovem toque curto. Soltura válida drena somente o bloco de entrada já captado em voo; a faixa física fica mutada. Essa extensão mínima e a remoção de `connecting` no componente compartilhado foram autorizadas pelo dono nesta revisão. Alterar o leaf e regenerar, sem canais/permissões novos. O elemento remoto usa `muted = listening`; a soltura restaura sem caption. O `AnalyserNode` fornece nível local ao Main, com a frequência existente.

Em `security.ts`, conceder mídia áudio-apenas ao frame principal de origem permitida dos papéis já autorizados e de `push-to-talk-voice`. Não exigir uma janela principal aberta e não conceder vídeo ou mídia às outras janelas. O Main mantém o pedido de Microfone do macOS. Testar o papel autorizado e os papéis que continuam negados.

### D15. Fim do turno pelo serviço; reprodução pelo gesto

O protocolo da assinatura não expõe `input_audio_buffer.commit` nem `turn_detection`; não enviar comandos inventados. O VAD decide o fim pelo silêncio após a soltura e ainda pode iniciar uma resposta numa pausa com a tecla presa.

**Autoridade da reprodução — revisão explícita de 2026-10-29 (V3/V4):** o dono substitui a regra anterior de saída sempre ao vivo. Aperto silencia imediatamente o elemento remoto; soltura restaura. Não há espera de caption, prova RMS, contador de turno, cancelamento remoto inventado nem buffer de saída. O serviço permanece dono do barge-in quando reconhece a próxima fala. Resposta consumida inteiramente durante o gesto fica só na legenda se não houver nova fala antes da soltura.

O registro anterior de 10.32 é preservado: após retirar atribuições indevidas por timeout, o dono respondeu explicitamente “sim” à interrupção pelo serviço e à consolidação do encerramento forçado. Essa aprovação foi válida para o desenho anterior; V3 agora muda somente a autoridade de reprodução local. A aprovação de 10.42 continua vigente.

Toque abaixo de 0,3 s não envia entrada. Tecla extra cancela e descarta áudio ainda não enviado; áudio já entregue pelo gesto válido não pode ser recolhido. Fechar sessão aberta pelo gesto se ainda não teve turno; não enviar contexto/print cancelado.

### D16. Sessão quente, delegação e resposta tardia

Iniciar SDP/ICE/sideband no `pressed`, em paralelo à fala e à captura. Reter a fala anterior à conexão em buffer local e mostrar "Ouvindo", não "Conectando". Após a resposta, manter sessão mutada por 90 s; réplica reutiliza conexão e memória.

Gesto solto sem fala/turno reconhecido tem limpeza limitada pela janela de 90 s. Turno do chamador cancela essa limpeza: ela não é timeout de resposta em processamento. Fora do gesto, áudio recebido toca imediatamente sem esperar legenda; durante o gesto, a reprodução fica mutada. Legendas continuam independentes.

Delegação pendente impede o fechamento por inatividade, com "Pensando". Reutilizar a nota aos 20 s e a desculpa falada aos 90 s do CallActor, sem inventar outro timeout de resposta. O teto absoluto é 10 min: `max_call_seconds` próprio no backend e encerramento pelo Main com `DELETE`, inclusive com delegação pendente.

Resposta do Router depois do teto ou com PTT desligado: "avisa e espera". Garantir que a continuação chegue à conversa pelo caminho existente do Router, inclusive quando `im_api.voice.say` encontra a chamada encerrada. O aviso pertence à chamada/delegação da conta original, não à primeira resposta arbitrária da conversa. Mostrar `ready` ("Resposta pronta") e balão; clicar abre a sidebar no texto do Router. Não iniciar ligação automática. Uma troca de conta invalida também avisos antigos.

A autorização tardia usa a origem fornecida pelo runtime, nunca metadados passados pelo modelo. A origem da delegação conserva `voice_mode`. No PTT, somente entradas `pending` com ACK conhecido geram `voice.delegation_handoff` com `voice_pending_delegation_ids`. Sem pendências aceitas, não há ingresso terminal. O handoff conserva o ingresso durável e o `agent_input` interno existente, invisível na timeline humana; não é evento de início/fim de chamada nem cria cartão. O dono autorizou a extensão mínima a `salix_im` para migrar esse valor e seus consumidores. `voice.say` aceita somente um desses IDs: argumento explícito inválido não escolhe outro, omissão exige um único pendente. Com vários, pedir `delegation_id`. A resposta muta por `ConversationServer -> ConversationActor`, sem redelivery para agentes/provedores. Não há nova entidade, índice, fila ou autoridade. Chamadas manuais, `note` e `hang_up` não recebem esse caminho; o manual mantém `voice.call_ended`.

A resposta final tardia usa a identidade de request já suportada pela conversa, derivada de chamada e delegação. Repetir o mesmo texto pela origem original ou pelo evento final retorna a mesma mensagem; texto conflitante é recusado pelo ConversationActor. Não há outro recibo ou dono de deduplicação.

A confirmação de fala ao vivo pertence ao CallActor e não cria recibo de append na conversa. A identidade acima deduplica a mensagem final tardia; não estabelece um limite global de `say` entre entrega ao vivo e entrega após o encerramento. Uma resposta explicitamente enviada depois do fim pela origem canônica da delegação continua no contrato de preservação.

O evento final projeta somente os ACKs conhecidos até o fim da espera limitada, não um inventário de aceitações futuras. Sem ACK no prazo, o resultado do forwarding é desconhecido: não autorizar esse ID pela origem final nem apagar, cancelar ou repetir o trabalho. Se o ingresso real aceitar depois, sua origem canônica original permite responder na conversa. Isso não exige outro recibo, snapshot ou dono de completude.

**Encerramento forçado — aprovado explicitamente:** o dono confirmou com “sim” nesta conversa as duas propostas após a auditoria, incluindo a consolidação do encerramento forçado. A confirmação posterior é a autorização válida, não o timeout de `ptt_forced_end_authority`. O mesmo CallActor possui fechamento da mídia e handoff. No fim normal, uma espera global de até 10 s cobre os ACKs do forwarding e a admissão do evento final; callbacks mantêm a mailbox responsiva. O marcador de tentativa não é recibo de aceitação; o resultado real do Router confirma o ingresso.

No force do drain, reutilizar o prazo absoluto dos 2 s restantes da política existente (notice até 5 s, force aos 8 s), sem iniciar outra espera de 10 s. Em `terminate/2`, usar o mesmo orçamento forçado, dentro da supervisão existente, para concluir o que for possível antes de perder a mailbox. Não depender de um timer que só seria processado depois do retorno. Sem admissão confirmada no prazo, registrar erro limitado e finalizar; não inventar ACK, cancelar/repetir trabalho desconhecido nem criar fila, entidade ou snapshot paralelo. A origem original continua válida para trabalho que for aceito posteriormente.


Reutilizar o poll serial de eventos da ligação (500 ms, até 200 eventos/512 KiB por página), apenas com a chamada ativa. A legenda acompanha a fala por frases; não prova leitura literal nem exige comparação de palavras. A observação da continuação tardia deve usar a identidade da delegação e a entrega existente da conversa, sem varredura de histórico ou poll por anexo.

### D17. Print associado ao mesmo pedido delegado

Captura, monitor, traço e recorte continuam em D3/D4. Correção aprovada pelo dono: o print nunca pode ser consumido por um pedido posterior por causa da ordem de upload. O Main atribui a cada gesto um `context_id` inteiro positivo, crescente no escopo da chamada. É correlação transitória, não identidade de arquivo ou entidade de domínio.

`POST /v1/comma/workspaces/:id/voice/calls/:call_id/context` usa o mesmo escopo `{tenant, group, user}` de `events` e `hang_up`, e quatro estados:

- `{"context_id": 1, "status": "pending"}` admite o gesto e invalida contextos anteriores ainda não entregues.
- `complete` entrega o texto e os arquivos desse contexto, como no exemplo abaixo.
- `{"context_id": 1, "status": "failed"}` ou `cancelled` invalida o contexto e termina a espera com erro explícito.

```json
{
  "context_id": 1,
  "status": "complete",
  "text": "App em primeiro plano, cursor, tamanho do print, área marcada e nomes dos arquivos",
  "attachments": [
    { "path": "/uploads/abcdefghijklmnopqrstuv-screen.png", "name": "screen.png", "mime": "image/png" },
    { "path": "/uploads/abcdefghijklmnopqrstuv-detail.png", "name": "detail.png", "mime": "image/png" }
  ]
}
```

O único localizador é o `path` devolvido por `uploadGroupFile`, com `name` e `mime`; não há identidade ou mapeamento paralelo de upload. O CallActor mantém apenas o contexto corrente e seu prazo. Contextos antigos e transições inválidas são recusados. Cancelamento recebido antes do `pending` não pode ser revertido por uma requisição atrasada.

O microfone capta localmente sem esperar captura/upload. O envio ao peer exige ACK do `pending` daquele contexto; soltura muta a captação, mas pode manter o buffer de gesto válido aguardando admissão. Isso impede enviar contra contexto anterior sem perder o início da fala. Captura e admissão ocorrem em paralelo, com fence da conta original.

A admissão tem prazo de 30 s, inclusive antes de `call.ready`; controles de falha/cancelamento também são limitados a 30 s. Rejeição, timeout ou falha de codificação invalida o gesto e informa o erro imediatamente, sem aguardar captura, soltura ou confirmação de `failed`. O controlador decide a falha; o transporte possui o aborto e o prazo.

O CallActor manda o texto como contexto silencioso (`:thinking` → `session.context.append`), nunca comentário para falar. O contexto admitido instrui o modelo a começar cada pedido delegado com `[ptt-context:N]`. O evento nativo não fornece identidade de gesto: por isso o CallActor exige, extrai e remove esse marcador, vincula o ID à delegação quando ela chega e não procura “o último print” ao despachar. Marcador ausente, inválido ou antigo causa erro explícito, sem executar silenciosamente um pedido de tela sem seu contexto.

Se a delegação chegar antes do upload, fica retida para aquele ID. No dispatch correspondente, o texto capturado também entra no pedido do Router, mesmo sem imagens. `complete` libera os anexos uma única vez por `enqueue_group_router_im_provider_message`, no formato VFS, com resolução do blob existente. Outra delegação não reutiliza as imagens.

O enqueue no Router é a fronteira de aceitação. Falha, cancelamento ou novo gesto invalida todo pedido ainda não enfileirado, inclusive contexto completo no settle de 300 ms; nunca envia esse pedido com anexos vazios por perda do contexto. Trabalho já enfileirado permanece aceito. Troca de conta e fim da chamada invalidam todas as continuações locais.

A espera do contexto tem teto de 150 s desde `pending` (120 s de gesto + 30 s de margem). Terminadas a captura e a admissão, o transporte limita upload/envio a 30 s; esse timer não prolonga o prazo global do contexto.

Prazo expirado e falha de captura/upload produzem falha visível e término da espera; nada de retenção indefinida ou fallback silencioso. Cancelamento termina a espera como cancelada e descarta o contexto, sem transformar a rejeição técnica da admissão cancelada em novo erro de envio. Um timer antigo não afeta contexto novo.

Com “Enviar print” desligado, completar só com texto e anexos vazios, sem captura, permissão ou upload. Com print solicitado e captura negada/falha, informar a falha; não fingir entrega nem completar silenciosamente como texto puro. Contexto não usa o rascunho, não abre janela e não muda foco. O modelo do Router precisa aceitar imagem (R1/R15).

Até duas operações de captura são reservadas antes de começar; canceladas continuam ocupando a reserva até terminarem. Não criar fila ilimitada. Se não há reserva, a voz continua sem esperar captura, mas o contexto falha visivelmente e não reutiliza print anterior. A barreira de apresentação espera somente capturas, não uploads, e restaura a legenda retida.

**Decisão do dono após a terceira rodada de revisão:** o dono escolheu explicitamente “Consolidar transições existentes” no `ask` desta sessão e confirmou a autorização. Reutilizar uma transição terminal por dono em cancelamento, falha e encerramento. Aceitação e handoff dependem do ACK real do enqueue no Router, nunca do flag anterior ao despacho. Requisições PTT, inclusive poll de eventos, têm prazo e aborto vinculados à chamada; não criar política global nova na API. Preservar o contrato externo e as garantias, sem nova entidade, fila durável, snapshots paralelos ou fallback. Primeiro reproduzir causalmente os três limites (admissão cancelada quente, HTTP de eventos travado e encerramento antes/durante forwarding); depois consolidar autoridade/transições, repetir provas, rebuild assinado e par de revisão completo. A alternativa de redesenhar fases internas não foi escolhida.


### D18. Corte limpo dos fluxos retirados

Remover os transcritores PTT (`local-transcription/push-to-talk-transcriber.ts`, `remote-transcriber.ts`), WAV/`push-to-talk/microphone.ts`, `delivery.ts`, `reply-watcher.ts`, `speaker.ts` e o modo de leitura de `live-voice.ts`. Remover `read_aloud`, a rota HTTP `say` e `sayVoiceCall` no backend/client; preservar `im_api.voice.say` usado pelo Router na chamada. Remover `pushToTalkSpeakReplies`, UI/i18n, erros de transcrição e dependência de Ajustes → Reunião. Não remover a transcrição de reuniões.

A máquina antiga de interrupção por caption, o campo `playback` e `interrupt()` continuam retirados, sem shim. V3 usa diretamente o gesto para mutar o elemento remoto, não reintroduz identidade sintética de áudio. Remover o estado/projeção/texto `connecting` do PTT, com regeneração dos contratos.

Apagar testes exclusivos dos comportamentos retirados; substituir reprodução sempre ao vivo por provas de mute imediato no aperto, restauração na soltura sem legenda e entrada fria preservada sem envio de toque curto. Preservar F1–F3 e F6–F8, os donos de uso/minutos/ingresso e os prazos de encerramento de D16/D17. D13–D18 substituem D5, D6, D7 e D12.
## Risks / Trade-offs

- **R1** — O Router pode não ter modelo com visão. O texto conserva app/coordenadas e nomes dos arquivos, mas não substitui a imagem; explicar a exigência nos Ajustes.
- **R2** — A conexão fria atrasa o envio, não perde o início captado: buffer local limitado e replay ordenado. O atraso resultante foi aceito pelo dono; medir no smoke.
- **R5** — Respostas delegadas dependem do Router. Medir soltura → primeiro áudio; respostas simples podem vir do próprio modelo de voz, sem novo caminho paralelo.
- **R7** — Print pode conter dados sensíveis. Manter envio desligável e aviso do destino; nada é capturado com print desligado.
- **R8** — Um atalho com tecla extra pode começar conexão/captura antes de cancelar. Mutar, descartar contexto/print e encerrar a sessão nova sem turno; áudio já transmitido não pode ser recolhido.
- **R9** — Entrada segura do macOS pode impedir eventos do tap. Atalho inativo nesse momento; risco aceito.
- **R12** — O VAD pode iniciar resposta com a tecla presa, mas V3/V4 a tornam inaudível. Se a resposta acabar antes da soltura, permanece só na legenda. Não prometer commit manual nem replay de saída.
- **R13** — Latência de conexão e admissão do contexto ainda não medida. Medir aperto → mídia/primeiro áudio, inclusive ACK de controle na réplica quente; nenhuma dessas etapas espera captura/upload.
- **R14** — Sessão aberta e espera de delegação consomem quota. Aplicar 90 s sem pendência e teto de 10 min; mostrar `plan_limit`, sem fallback nem reconexão automática.
- **R15** — O Router precisa de visão (R1). Verificar print no mesmo pedido, inclusive com delegação antes do upload; marcador de contexto ausente/antigo deve falhar explicitamente. O modelo de voz não vê imagens. Medir no smoke real se o serviço respeita a correlação instruída; não inferir isso de fixtures.

- **R16** — Silenciar no aperto não cancela a geração remota. O serviço faz barge-in ao reconhecer nova fala; a soltura restaura a mídia corrente, sem replay do que passou mutado. Voz real, TCC e latência continuam reservados a 8.2 e 9.1–9.3.
## Migration Plan

Função desligada por padrão; sem migração de dados de conversa ou nova entidade. Remover a preferência obsoleta de resposta falada e seus consumidores; manter as demais preferências. Atualizar backend e cliente para `push_to_talk`/`context`, sem compatibilidade com o modo de leitura retirado. Desligar PTT encerra a chamada; trabalho delegado já aceito continua na conversa, sem retorno automático de voz. Não implantar a branch: integração e rollout seguem o fluxo mainline aprovado do projeto.
