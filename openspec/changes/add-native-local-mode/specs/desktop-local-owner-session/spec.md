# Spec Delta

## Purpose

Define como o usuário entra no Comma quando o app usa o backend local: sem login, como o único dono da instalação, sem expor uma forma de entrar a outros programas ou pessoas.

## ADDED Requirements

### Requirement: Entrada automática do dono

No modo local, o app SHALL entrar automaticamente como o dono da instalação, sem pedir e-mail, código ou senha. Na primeira abertura, o app SHALL criar esse dono e o workspace dele. Nas aberturas seguintes, SHALL entrar como o mesmo dono.

#### Scenario: Primeira abertura sem login

- **WHEN** o usuário abre o app pela primeira vez no modo local
- **THEN** o app cria o dono e o workspace e mostra a Home já com a sessão aberta, sem tela de login

#### Scenario: Mesma conta nas aberturas seguintes

- **WHEN** o usuário fecha e abre o app de novo
- **THEN** o app entra na mesma conta, com o mesmo workspace e o histórico de antes

#### Scenario: Sessão expirada ou revogada

- **WHEN** a sessão guardada pelo app não é mais aceita pelo backend local
- **THEN** o app cria uma sessão nova para o mesmo dono e entra sem mostrar a tela de login

### Requirement: Credencial de administração restrita ao app

A credencial que permite criar o dono e a sessão SHALL ser gerada por instalação, SHALL ficar só no processo principal do app e nos arquivos de dados do usuário com permissão restrita ao próprio usuário, e SHALL NOT ser exposta à interface, aos logs nem a outros processos por variável ou argumento visível. O backend local SHALL aceitar essa credencial apenas em conexões de loopback.

#### Scenario: Interface sem credencial

- **WHEN** o código da interface do app é inspecionado em execução
- **THEN** nem a credencial de administração nem o token da sessão estão acessíveis a ele

#### Scenario: Arquivos de segredo

- **WHEN** os arquivos de segredo da instalação são listados
- **THEN** só o usuário dono tem permissão de leitura e escrita neles

### Requirement: Sem login nem e-mail no modo local

No modo local, a tela de login e o envio de código por e-mail SHALL NOT aparecer. Sair da conta SHALL encerrar a sessão atual e voltar a entrar automaticamente como o dono, sem mostrar a tela de login.

#### Scenario: Sair da conta

- **WHEN** o usuário escolhe sair da conta no modo local
- **THEN** a sessão anterior deixa de valer e o app volta a entrar como o dono

#### Scenario: Nenhum e-mail enviado

- **WHEN** o app entra no modo local
- **THEN** nenhum e-mail de código é gerado nem enviado
