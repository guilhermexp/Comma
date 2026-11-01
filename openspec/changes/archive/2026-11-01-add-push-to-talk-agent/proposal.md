# Proposta

## Por quê

Para pedir algo sobre a tela, o usuário precisa abrir o Comma e explicar onde olhar. O atalho deve permitir turnos de fala ao agente, sem abrir janela nem parecer uma ligação. O GPT Live continua por baixo: o modelo de voz responde e delega ao Router o trabalho que exige o agente do workspace. A revisão V1–V5 foi aprovada explicitamente pelo dono em 2026-10-29.

## O que muda

- **Falar com o agente segurando um atalho**, em qualquer app e com a janela principal fechada:
  - um atalho global próprio, padrão **`⌃⌥` sozinhos** (só modificadores), separado do atalho que abre a sidebar; também aceita tecla + modificador;
  - apertar abre ou reutiliza a sessão oculta, limpa a legenda anterior, silencia imediatamente a reprodução remota e começa a captar o microfone; soltar muta o microfone e restaura a reprodução, sem esperar print ou legenda;
  - a fala anterior à conexão fica num buffer local limitado; após conexão, admissão do contexto e confirmação do gesto de 0,3 s, o peer envia esse início e segue com a fala ao vivo, em ordem;
  - com atalho só de modificadores, apertar outra tecla durante o gesto (ex.: `⌃⌥←`) cancela a captação e descarta o buffer ainda não enviado;
  - um toque abaixo de 0,3 s não envia áudio nem contexto/print; se abriu uma sessão que ainda não teve turno, ela é encerrada;
  - o serviço decide o fim do turno. Resposta iniciada numa pausa com a tecla presa fica inaudível; a fala seguinte provoca barge-in do serviço. Se terminar antes da soltura, fica só na legenda, sem replay.
- **"Isso aqui" vai ao Router**: no aperto, o Comma captura o monitor do cursor antes de mostrar a sobreposição. O usuário pode desenhar um traço. O Main envia o print e o recorte pelo upload existente, depois associa os arquivos e o contexto textual à chamada. O modelo de voz recebe apenas texto e deve delegar pedidos sobre a tela; os anexos acompanham a próxima delegação ao Router, uma única vez.
- **Sem aparência ou registro de ligação**: o modo `push_to_talk` não espera perfil nem saúda e mantém a delegação ativa. Não registra evento/cartão de início ou fim de chamada na conversa. Uso/minutos, ingresso e handoff de trabalho pendente continuam pelos donos existentes. A chamada manual mantém seus registros. Não depende da transcrição de reuniões.
- **Sessão quente**: depois da resposta, fica mutada e invisível por 90 s para uma réplica na mesma sessão. Uma delegação pendente mantém a chamada aberta, mas nunca além de 10 min. Uma chamada manual e o PTT se excluem: `busy` e `plan_limit` aparecem como erro, sem voz alternativa.
- **Resposta tardia: avisa e espera**: depois do teto ou com PTT desligado, a resposta do Router permanece na conversa. Notch/companheiro mostram "Resposta pronta" com balão; clicar abre a sidebar. O app não inicia outra chamada sozinho.
- **Cursor companheiro e notch**: mostram "Ouvindo" desde o aperto, sem "Conectando", com o nível real do microfone; depois "Pensando" durante a espera/delegação e "Falando" com legenda frase a frase. A sessão quente fica sem UI; uma resposta tardia mostra "Resposta pronta".
- **Ajustes**: ligar/desligar a função, escolher o atalho e enviar ou não o print. A voz é inerente à chamada; sai o ajuste de resposta falada e sua dependência de Ajustes → Reunião.
- **Permissões**: Microfone para a janela oculta de voz, sem ampliar o acesso das outras janelas; Gravação de Tela para o próprio Comma apenas com print ligado; Monitoramento de Entrada apenas para atalho só de modificadores. Falta de permissão aparece com a ação correspondente. Com “Enviar print” ligado e Gravação de Tela negada, o contexto falha explicitamente, sem envio automático do pedido sem print. Desligar “Enviar print” permite um novo gesto só com voz e contexto textual.

Fora do escopo: alterar a UI da chamada manual; controlar o VAD por protocolo não documentado; enviar imagem diretamente ao modelo de voz; persistir uma transcrição integral da chamada; o agente apontar ou desenhar na tela; bolinhas de tarefas; ASR separado, TTS do sistema ou por provedor pago; Windows e Linux. Helper Swift e NotchHost já implementados são preservados, sem mudanças nesta revisão.

## Capacidades

### Novas capacidades

- `agent-push-to-talk`: chamada GPT Live por atalho global, com microfone controlado pelo gesto, contexto da tela delegado ao Router, sessão de réplica, resposta tardia, companheiro, notch, permissões e ajustes.

### Capacidades modificadas

Nenhuma capability adicional. A revisão altera apenas esta capability da change; não modifica as specs publicadas nem a transcrição de reuniões.

## Impacto

- **Electron main**: controlador da chamada, sinalização e eventos, ciclo de 90 s/10 min, fence de conta, captura/upload/contexto e integração com as janelas e o notch existentes. Remove os transcritores PTT, WAV, entrega de mensagem transcrita, observador de respostas e speaker do sistema, com seus testes.
- **Janela de voz** (`push-to-talk-voice`): microfone real com buffer de entrada local, faixa WebAudio do peer e reprodução remota controlada pelo gesto, nunca por legenda. Continua oculta e sem foco. O contrato nativo separa gesto, contexto admitido e identidade transitória do contexto; os artefatos são regenerados.
- **Interface e API client** (`clients/packages/app`): Ajustes sem resposta falada nem dependência de Reunião; legendas e erros da chamada; contrato de início com `mode: "push_to_talk"` e envio de contexto; textos em `en`, `pt-BR` e `zh-CN`.
- **Backend** (`systems/apps/salix_voice`, `systems/apps/comma_web`): modo `push_to_talk` e `POST /v1/comma/workspaces/:id/voice/calls/:call_id/context`, com escopo `{tenant, group, user}`. O CallActor entrega texto à sessão e anexos à próxima delegação; garante a continuação na conversa se a chamada terminar antes da resposta.
- **BREAKING — remoção do modo de leitura**: sai `read_aloud`, a rota HTTP `say` e seu cliente. A ferramenta do Router `im_api.voice.say` da chamada normal permanece; sua resposta após o fim da chamada deve chegar à conversa.
- **Domínio**: reutiliza chamada, Group/workspace, arquivos e delegação existentes; nenhuma entidade nova. Mutações de conversa continuam por `ConversationServer -> ConversationActor`.
- **Privacidade e dependências**: áudio vai ao serviço GPT Live da conta ChatGPT; prints vão ao Router e ao provedor do modelo dele, que precisa aceitar imagem. "Enviar print" desligado envia apenas contexto textual, sem captura ou upload. Não há mudança no helper Swift, no NotchHost nem em serviços de reuniões.
