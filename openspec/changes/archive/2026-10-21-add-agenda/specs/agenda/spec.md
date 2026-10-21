# Spec Delta

## Purpose

Dar ao usuário uma Agenda dentro do Comma que mostra, num só lugar e no fuso local, os eventos do Google Calendar e do Calendário do Mac, e permite criar, editar, mover e apagar esses eventos na fonte de origem.

## ADDED Requirements

### Requirement: Item Agenda na sidebar

A sidebar MUST ter o item "Agenda", com ícone de calendário, que abre a rota `#/agenda`. O item MUST seguir as mesmas regras dos outros itens: reordenável, com atalho de teclado e ausente para convidados. Quem já tem uma ordem salva MUST ver o item novo no fim, sem perder a ordem existente.

#### Scenario: Abrir a Agenda

- **WHEN** o usuário clica em "Agenda" na sidebar
- **THEN** o app abre `#/agenda` na visão Semana da semana atual e marca o item como ativo

#### Scenario: Ordem salva

- **WHEN** o usuário tinha salvo a ordem home, tasks, inbox, drive, plugins
- **THEN** a sidebar mostra essa ordem com "Agenda" depois de plugins

#### Scenario: Convidado

- **WHEN** a sessão é de convidado
- **THEN** a sidebar não mostra "Agenda"

### Requirement: Visões e navegação

A Agenda MUST oferecer as visões "3 dias", "Semana" (segunda a domingo) e "Mês", além dos botões anterior, "Hoje" e próximo. O título MUST mostrar a visão e o período. A visão e a data escolhidas MUST ficar na URL, para sobreviver a recarregar e voltar.

#### Scenario: Semana

- **WHEN** hoje é terça, 20 out 2026, e a visão é Semana
- **THEN** o título mostra "Semana 19 – 25 out 2026" e as colunas vão de seg 19 a dom 25

#### Scenario: Próximo e Hoje

- **WHEN** o usuário clica em próximo duas vezes e depois em "Hoje"
- **THEN** a Agenda avança duas semanas e volta para a semana atual

#### Scenario: 3 dias

- **WHEN** o usuário escolhe "3 dias"
- **THEN** a grade mostra o dia de hoje e os dois seguintes, e anterior e próximo andam 3 dias

#### Scenario: Recarregar

- **WHEN** o usuário está em Mês de dezembro de 2026 e recarrega a página
- **THEN** a Agenda volta em Mês de dezembro de 2026

### Requirement: Grade de horários

As visões 3 dias e Semana MUST mostrar o cabeçalho de cada dia, a linha "Dia inteiro" e a grade de horas. O cabeçalho MUST trazer dia da semana, data e total de horas ocupadas por eventos com horário ("—" quando não há). O dia atual MUST ter destaque e uma linha vermelha na hora atual, que se atualiza enquanto a tela está aberta. Ao abrir, a grade MUST rolar até perto da hora atual.

#### Scenario: Total do dia

- **WHEN** a quarta tem eventos de 10:15–10:45, 10:45–12:00 e 12:00–13:00
- **THEN** o cabeçalho da quarta mostra "2 h 45 min"

#### Scenario: Eventos sobrepostos

- **WHEN** dois eventos do mesmo dia se sobrepõem no horário
- **THEN** eles aparecem lado a lado na coluna, sem um cobrir o outro

#### Scenario: Evento de vários dias

- **WHEN** um evento de dia inteiro vai de quinta a sábado
- **THEN** ele aparece uma vez na linha "Dia inteiro", ocupando as três colunas

#### Scenario: Linha do agora

- **WHEN** são 14:50 e a semana exibida contém hoje
- **THEN** uma linha vermelha cruza a grade às 14:50, com um ponto na coluna de hoje

### Requirement: Visão Mês

A visão Mês MUST mostrar as semanas do mês em linhas de segunda a domingo e, em cada dia, os eventos em ordem de início. Quando não couberem, MUST mostrar "+N" e abrir a lista completa do dia ao clicar.

#### Scenario: Dia cheio

- **WHEN** um dia tem 7 eventos e a célula comporta 3
- **THEN** a célula mostra 3 eventos e "+4"

### Requirement: Zoom da grade

A Agenda MUST ter zoom da altura das horas de 75% a 200%, em passos de 25%, pelos botões − e + e pelo percentual exibido. O zoom MUST ser lembrado no dispositivo.

#### Scenario: Aumentar zoom

- **WHEN** o zoom está em 100% e o usuário clica em + duas vezes
- **THEN** o percentual mostra 150% e cada hora fica 1,5 vez mais alta

#### Scenario: Limite

- **WHEN** o zoom está em 200%
- **THEN** o botão + fica desativado

### Requirement: Painel de calendários

Um painel lateral recolhível MUST listar as fontes (cada conta Google conectada e "Calendário do Mac"), com os calendários de cada uma, sua cor e uma caixa para mostrar ou esconder. A escolha MUST ser lembrada no dispositivo. Os eventos MUST usar a cor do calendário.

#### Scenario: Esconder calendário

- **WHEN** o usuário desmarca o calendário "Feriados"
- **THEN** os eventos desse calendário somem da grade e continuam escondidos depois de reabrir o app

#### Scenario: Sem conta Google

- **WHEN** não há conta `googlecalendar` conectada
- **THEN** o painel mostra "Conectar Google Calendar", que leva ao fluxo de conexão Composio já existente

### Requirement: Fontes reunidas sem duplicar

A Agenda MUST mostrar juntos os eventos de todas as fontes visíveis. Calendários do Mac pertencentes a uma conta Google já conectada pela Composio MUST começar escondidos. O usuário MUST poder reexibi-los.

#### Scenario: Conta Google também no Mac

- **WHEN** a conta `ana@gmail.com` está conectada pela Composio e também adicionada no Calendário do Mac
- **THEN** os calendários dessa conta no grupo do Mac começam desmarcados e cada evento aparece uma vez

### Requirement: Detalhes do evento

Clicar num evento MUST abrir os detalhes: título, data e horário, calendário e fonte, local, descrição e, para o Google, o link para abrir no Google Calendar. Em calendário editável, os campos MUST ser editáveis. Em calendário só de leitura, MUST aparecer apenas a leitura e um aviso.

#### Scenario: Evento só de leitura

- **WHEN** o usuário abre um evento do calendário "Feriados no Brasil"
- **THEN** os campos aparecem sem edição e o painel diz que esse calendário não permite alterações

### Requirement: Criar evento

O usuário MUST poder criar um evento clicando num horário vazio (30 minutos) ou arrastando um intervalo, e também clicando na linha "Dia inteiro". O formulário MUST pedir título e calendário. O calendário padrão é o último usado, ou o principal da primeira conta. Ao salvar, o evento MUST ser gravado na fonte do calendário escolhido.

#### Scenario: Arrastar intervalo

- **WHEN** o usuário arrasta na quinta de 15:00 a 16:30, digita "Revisão" e salva no calendário Google "Trabalho"
- **THEN** o evento "Revisão" de 15:00 a 16:30 é criado nesse calendário e aparece na grade

#### Scenario: Calendário do Mac

- **WHEN** o usuário cria um evento no calendário "Casa" do Mac
- **THEN** o evento é gravado no Calendário do Mac e aparece também no app Calendário

### Requirement: Editar, mover e redimensionar

Em evento de calendário editável, o usuário MUST poder alterar título, início, fim, dia inteiro, local, descrição, calendário de destino e repetição. Também MUST poder mover o evento arrastando para outro horário ou dia, e redimensionar pela borda de baixo. O arraste MUST encaixar em passos de 15 minutos.

#### Scenario: Mover

- **WHEN** o usuário arrasta um evento de quarta 10:00–11:00 para sexta às 14:00
- **THEN** o evento passa a sexta, de 14:00 a 15:00, na fonte de origem

#### Scenario: Redimensionar

- **WHEN** o usuário puxa a borda de baixo de um evento 12:00–13:00 até 13:45
- **THEN** o evento termina às 13:45

#### Scenario: Trocar de calendário na mesma fonte

- **WHEN** o usuário troca o calendário de um evento Google de "Pessoal" para "Trabalho" da mesma conta
- **THEN** o evento passa para "Trabalho" e mantém os demais dados

### Requirement: Calendário de destino de outra fonte

Mover um evento para um calendário de outra fonte ou de outra conta MUST criar o evento no destino e apagar o original só depois que a criação der certo. Antes, o app MUST avisar que os convidados e o histórico do original não vão junto.

#### Scenario: Do Mac para o Google

- **WHEN** o usuário troca o calendário de um evento do Mac para um calendário Google e confirma o aviso
- **THEN** o evento passa a existir no Google e deixa de existir no Mac

#### Scenario: Falha na criação

- **WHEN** a criação no destino falha
- **THEN** o original continua intacto e o app mostra o erro

### Requirement: Repetição

Ao criar ou editar, o usuário MUST poder escolher a repetição: nenhuma, diária, semanal, mensal ou anual. Eventos com repetição personalizada vinda da fonte MUST ser exibidos, e a repetição deles MUST aparecer como "Personalizada" e não ser editável. Ao editar ou apagar uma ocorrência, o app MUST perguntar "Só este evento" ou "Todos os eventos".

#### Scenario: Mover só uma ocorrência

- **WHEN** o usuário arrasta a ocorrência de quarta de uma reunião semanal e escolhe "Só este evento"
- **THEN** só a ocorrência dessa quarta muda de horário

#### Scenario: Apagar a série

- **WHEN** o usuário apaga uma ocorrência e escolhe "Todos os eventos"
- **THEN** todas as ocorrências da série somem

### Requirement: Apagar evento

O usuário MUST poder apagar um evento editável pelos detalhes ou pela tecla Delete com o evento selecionado, depois de confirmar.

#### Scenario: Apagar

- **WHEN** o usuário seleciona um evento, aperta Delete e confirma
- **THEN** o evento é apagado na fonte e some da grade

### Requirement: Alterações otimistas com reversão

Criar, mover, redimensionar, editar e apagar MUST refletir na grade imediatamente. Se a fonte recusar, a grade MUST voltar ao estado anterior e mostrar o motivo.

#### Scenario: Sem permissão de escrita

- **WHEN** o usuário move um evento Google e a conta não tem permissão de escrita
- **THEN** o evento volta ao lugar e o app mostra "Reconecte a conta Google com permissão para editar a agenda", com o botão de reconectar

### Requirement: Atualização dos eventos

A Agenda MUST buscar os eventos do período visível ao abrir, ao navegar, ao voltar o foco para o app e a cada 60 s enquanto está visível. MUST também buscar depois de cada alteração feita nela. No Mac, MUST atualizar quando o Calendário do Mac avisar mudança. Uma fonte com erro MUST mostrar o aviso só nela, sem esconder as outras.

#### Scenario: Mudança feita fora

- **WHEN** o usuário cria um evento no app Calendário do Mac com a Agenda aberta
- **THEN** o evento aparece na Agenda sem recarregar

#### Scenario: Google fora do ar

- **WHEN** a leitura do Google falha e a do Mac funciona
- **THEN** os eventos do Mac aparecem e o painel marca a conta Google com erro e "Tentar de novo"

### Requirement: Fuso e idioma

Todos os horários MUST aparecer no fuso do sistema, com formatos do idioma do app. Eventos de dia inteiro MUST manter a data de calendário, sem deslocar por fuso.

#### Scenario: Dia inteiro em outro fuso

- **WHEN** o fuso do sistema é `America/Sao_Paulo` e um evento de dia inteiro é de 25 out
- **THEN** ele aparece só em 25 out
