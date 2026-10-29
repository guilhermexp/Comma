# Proposta

## Por quê

Para pedir algo sobre a tela, o usuário precisa abrir o Comma e explicar onde olhar. O atalho deve iniciar uma chamada GPT Live, como "Call Comma", sem abrir janela: o modelo de voz escuta, responde e delega ao Router o trabalho que exige o agente do workspace.

## O que muda

- **Falar com o agente segurando um atalho**, em qualquer app e com a janela principal fechada:
  - um atalho global próprio, padrão **`⌃⌥` sozinhos** (só modificadores), separado do atalho que abre a sidebar; também aceita tecla + modificador;
  - apertar abre ou reutiliza a sessão de voz, limpa a legenda anterior na UI e desmuta o microfone quando conectado; soltar muta a faixa imediatamente, sem esperar o print;
  - interrupção pelo serviço, como no Call Comma: a saída falada não é cortada localmente pelo simples aperto da tecla sem fala reconhecida; o serviço GPT Live interrompe a resposta ao reconhecer a nova fala (barge-in nativo); uma cauda anterior pode continuar até o reconhecimento; áudio novo nunca aguarda legendas;
  - com atalho só de modificadores, apertar outra tecla durante o gesto (ex.: `⌃⌥←`) cancela a captação;
  - um toque abaixo de 0,3 s é descartado; se abriu uma sessão que ainda não teve turno, ela é encerrada. O áudio já transmitido não pode ser recolhido;
  - o serviço decide o fim do turno. Uma pausa longa com a tecla presa pode antecipar a resposta; esse risco é aceito.
- **"Isso aqui" vai ao Router**: no aperto, o Comma captura o monitor do cursor antes de mostrar a sobreposição. O usuário pode desenhar um traço. O Main envia o print e o recorte pelo upload existente, depois associa os arquivos e o contexto textual à chamada. O modelo de voz recebe apenas texto e deve delegar pedidos sobre a tela; os anexos acompanham a próxima delegação ao Router, uma única vez.
- **Chamada sem saudação**: o modo `push_to_talk` não espera o perfil para começar e mantém a delegação ativa. Registra início e fim como a chamada manual. Não depende da transcrição de reuniões.
- **Sessão quente**: depois da resposta, fica mutada e invisível por 90 s para uma réplica na mesma sessão. Uma delegação pendente mantém a chamada aberta, mas nunca além de 10 min. Uma chamada manual e o PTT se excluem: `busy` e `plan_limit` aparecem como erro, sem voz alternativa.
- **Resposta tardia: avisa e espera**: depois do teto ou com PTT desligado, a resposta do Router permanece na conversa. Notch/companheiro mostram "Resposta pronta" com balão; clicar abre a sidebar. O app não inicia outra chamada sozinho.
- **Cursor companheiro e notch**: mostram "Conectando", "Ouvindo" com o nível real do microfone, "Pensando" durante a espera/delegação e "Falando" com legenda frase a frase. A sessão quente fica sem UI; uma resposta tardia mostra "Resposta pronta".
- **Ajustes**: ligar/desligar a função, escolher o atalho e enviar ou não o print. A voz é inerente à chamada; sai o ajuste de resposta falada e sua dependência de Ajustes → Reunião.
- **Permissões**: Microfone para a janela oculta de voz, sem ampliar o acesso das outras janelas; Gravação de Tela para o próprio Comma apenas com print ligado; Monitoramento de Entrada apenas para atalho só de modificadores. Falta de permissão aparece com a ação correspondente. Sem Gravação de Tela, a chamada continua sem print.

Fora do escopo: alterar a UI da chamada manual; controlar o VAD por protocolo não documentado; enviar imagem diretamente ao modelo de voz; persistir uma transcrição integral da chamada; o agente apontar ou desenhar na tela; bolinhas de tarefas; ASR separado, TTS do sistema ou por provedor pago; Windows e Linux. Helper Swift e NotchHost já implementados são preservados, sem mudanças nesta revisão.

## Capacidades

### Novas capacidades

- `agent-push-to-talk`: chamada GPT Live por atalho global, com microfone controlado pelo gesto, contexto da tela delegado ao Router, sessão de réplica, resposta tardia, companheiro, notch, permissões e ajustes.

### Capacidades modificadas

Nenhuma capability adicional. A revisão altera apenas esta capability da change; não modifica as specs publicadas nem a transcrição de reuniões.

## Impacto

- **Electron main**: controlador da chamada, sinalização e eventos, ciclo de 90 s/10 min, fence de conta, captura/upload/contexto e integração com as janelas e o notch existentes. Remove os transcritores PTT, WAV, entrega de mensagem transcrita, observador de respostas e speaker do sistema, com seus testes.
- **Janela de voz** (`push-to-talk-voice`): peer com microfone real, faixa do microfone mutada por padrão, áudio remoto sempre ao vivo para interrupção nativa pelo serviço e nível de áudio; permissão de mídia por papel no Main. Continua oculta e sem foco.
- **Interface e API client** (`clients/packages/app`): Ajustes sem resposta falada nem dependência de Reunião; legendas e erros da chamada; contrato de início com `mode: "push_to_talk"` e envio de contexto; textos em `en`, `pt-BR` e `zh-CN`.
- **Backend** (`systems/apps/salix_voice`, `systems/apps/comma_web`): modo `push_to_talk` e `POST /v1/comma/workspaces/:id/voice/calls/:call_id/context`, com escopo `{tenant, group, user}`. O CallActor entrega texto à sessão e anexos à próxima delegação; garante a continuação na conversa se a chamada terminar antes da resposta.
- **BREAKING — remoção do modo de leitura**: sai `read_aloud`, a rota HTTP `say` e seu cliente. A ferramenta do Router `im_api.voice.say` da chamada normal permanece; sua resposta após o fim da chamada deve chegar à conversa.
- **Domínio**: reutiliza chamada, Group/workspace, arquivos e delegação existentes; nenhuma entidade nova. Mutações de conversa continuam por `ConversationServer -> ConversationActor`.
- **Privacidade e dependências**: áudio vai ao serviço GPT Live da conta ChatGPT; prints vão ao Router e ao provedor do modelo dele, que precisa aceitar imagem. "Enviar print" desligado envia apenas contexto textual, sem captura ou upload. Não há mudança no helper Swift, no NotchHost nem em serviços de reuniões.
