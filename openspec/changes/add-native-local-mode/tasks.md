# Tasks

## 1. Backend como release nativa relocável

- [x] 1.1 Fixar versões e sha256 de OpenSSL, libsodium, libopus, Erlang/OTP, Postgres 16 (zonky darwin arm64), Redis e MinIO num manifesto versionado em `clients/apps/electron/scripts/` e verificar que um script de download rejeita um arquivo com sha256 diferente (teste unitário do verificador)
- [x] 1.2 Script que compila OpenSSL, libsodium e libopus num prefixo do build e o Erlang/OTP linkado a esse OpenSSL; verificar com `otool -L` que `crypto.so` aponta para o prefixo (não para `/opt/homebrew`)
- [x] 1.3 Gerar `MIX_ENV=prod mix release comma` para macOS arm64 com verified kernel, NIFs C, `mdex`, `spinfoam` e assets, usando o prefixo de 1.2; verificar que `bin/comma eval 'IO.puts(:ok)'` roda com `PATH=/usr/bin:/bin` e sem `DYLD_*`
- [x] 1.4 Script de gate que percorre todos os Mach-O de uma pasta e falha em dependência fora de `@rpath`/`@loader_path`/`@executable_path`/`/usr/lib`/`/System`; começar por teste que falha com um binário do Homebrew e passa com a release de 1.3
- [x] 1.5 Obter Postgres (zonky), compilar Redis (`BUILD_TLS=no`) e baixar MinIO para `local-backend/`; verificar com o gate de 1.4 e confirmar que `citext`, `pgcrypto`, `btree_gin` e `pg_trgm` estão no pacote (`CREATE EXTENSION` num `initdb` temporário)

## 2. Backend: pontos de entrada do modo local

- [x] 2.1 Teste ExUnit que falha: com `COMMA_ENVIRONMENT=local`, uma chamada às rotas `/v1/comma/admin/*` vinda de IP que não é loopback recebe 403 mesmo com o token certo; implementar a checagem e ver o teste passar (rotas de admin em `comma_web`)
- [x] 2.2 Garantir que `Comma.FreshInstall.run/0` roda pela release (`bin/comma eval`) com a configuração gerada e é idempotente: teste que roda duas vezes num banco vazio e confere que a segunda só aplica pendências
- [x] 2.3 Documentar em `systems/README.md` (ou `DEPLOYMENT.md`) o comando de preparação e as variáveis do modo local; verificar com `pnpm docs:check`

## 3. Electron: supervisor do backend local

- [x] 3.1 Módulo no Main que gera `secrets.json` (0600) e `state.json` na pasta `~/Library/Application Support/Comma/local`, reaproveitando os existentes; testes unitários de primeira geração, reaproveitamento, permissão 0600 e chave de assinaturas nunca regenerada
- [x] 3.2 Escolha de portas livres em `127.0.0.1`, persistidas e trocadas quando ocupadas; testes com porta ocupada
- [x] 3.3 Geração da configuração do backend (mesmo formato de `.local/native/config.json`) a partir de 3.1 e 3.2; teste de snapshot sem segredos no log
- [x] 3.4 Supervisor dos quatro processos (ordem, `initdb`/bucket na primeira vez, `/health`, reinício com espera crescente, parada após 5 falhas em 2 min, limpeza de órfãos por PID conferindo o executável); testes com processos falsos para crash, reinício, desistência e órfão
- [x] 3.5 Backup com `pg_dump` quando a versão do app muda, mantendo os 3 últimos, e erro claro se a preparação falhar; testes de rotação e de falha de migração sem abrir a interface
- [x] 3.6 Encerramento no `before-quit` (backend, Postgres `fast`, Redis, MinIO, `SIGKILL` após o limite); teste com processos falsos e verificação manual de que nada fica rodando após fechar

## 4. Electron: sessão do dono e URL em tempo de execução

- [x] 4.1 Flavor `prod` com `COMMA_DEFINED_BACKEND_MODE=local` e sem URL fixa; o Main define a URL da API pela porta escolhida antes de criar janelas e o renderer a recebe pelo canal da configuração; testes de `release-config` para os dois modos
- [x] 4.2 Criação do dono (`POST /v1/comma/admin/users`) e da sessão `local_dev` (`POST .../sessions`), guardando o id em `state.json` e o token no armazenamento seguro; `startup-session` aceita a sessão do modo local em app empacotado; testes de primeira vez, reuso, 401 com recriação e "Sair" recriando a sessão
- [x] 4.3 Teste que confirma que o renderer não recebe o token de administração nem o token de sessão (inspeção da ponte/preload)
- [x] 4.4 Tela de inicialização e de erro no renderer seguindo `~/.agents/skills/impeccable/SKILL.md` (estados: iniciando, preparando dados, erro com "Tentar de novo", "Mostrar logs" e local dos backups), com textos em en, pt-BR e zh-CN; testes de componente e captura de tela

## 5. Release e CI

- [x] 5.1 Integrar 1.2 a 1.5 ao `build:native`/release: `local-backend/` dentro de `Contents/Resources`, assinatura ad hoc de todos os binários, gate de 1.4 antes do `vpk pack`; verificar com um build local completo e `codesign --verify --deep --strict`
- [x] 5.2 Atualizar `.github/workflows/desktop-release.yml`: cache do prefixo nativo pela chave das versões, passos de 1.x, remoção de `COMMA_API_BASE_URL`; verificar com `actionlint` e um `workflow_dispatch` sem publicar (ou uma tag de prerelease aprovada)
- [x] 5.3 Atualizar o runbook de release e as instruções de primeira instalação (o que o app faz na primeira abertura, onde ficam os dados e os backups, como apagar a instalação local); verificar com `pnpm docs:check`

## 6. Integração

- [x] 6.1 E2E no Electron empacotado: abrir com pasta de dados vazia, ver a Home já logada sem tela de login, mandar uma mensagem ao Router, fechar, reabrir e ver a conversa; confirmar que nenhum processo ficou rodando depois de fechar
- [ ] 6.2 Prova em ambiente limpo: rodar o app gerado pelo CI num usuário macOS novo (ou outro Mac) sem Homebrew no `PATH`, com o backend de desenvolvimento do dono rodando ao mesmo tempo; registrar capturas e logs
- [ ] 6.3 Atualização: instalar a versão anterior com dados, atualizar pela atualização automática para a nova e confirmar backup criado, migração aplicada e dados preservados
- [ ] 6.4 Acesso pela rede: de outro dispositivo da rede, confirmar que as portas do backend local recusam conexão

## Workflow follow-up

- Revisão de código com `/requesting-code-review` (área sensível: segredos, sessão sem login, processos filhos).
- Publicar a release seguinte com a tag `v<versão>` depois do aceite.
- Arquivar a change com `/openspec-archive-change`, rodar `/sync` e `/cleanup`.
