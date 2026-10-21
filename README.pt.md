# Obi-I para Obsidian

🇬🇧 [Read in English](README.md)

## O que é o Obi-I

O Obi-I executa agentes de IA dentro do Obsidian. Cada agente é uma nota na pasta Obi-I. Fala com eles no Chat, e eles respondem com a ferramenta de IA que instalou (Claude Code, Codex, OpenCode ou Hermes), que usa a sua própria conta e o seu plano. Pode dar-lhes uma equipa com um organograma editável, Tasks, History, difusões e um revisor que verifica o trabalho.

Feito por Marcio Vieira — guias, tutoriais, transferências e feedback em [trabalhoia.com](https://trabalhoia.com).

## O que precisa

- Obsidian desktop, em Windows ou Mac: https://obsidian.md
- Pelo menos uma ferramenta de IA, instalada e com sessão iniciada. Claude Code (um plano Claude ou uma chave de API): https://code.claude.com/docs/en/setup . Codex CLI (um plano ChatGPT; versão 0.160.0 ou mais recente; uma versão mais recente é verificada uma vez pelo Obi-I e depois usada): https://github.com/openai/codex . OpenCode (versão 1.19.1 ou mais recente, verificada da mesma forma): https://opencode.ai . Hermes: veja a secção Hermes no [README.md](README.md).
- Node.js, apenas para o controlo do navegador: https://nodejs.org
- O Python vem com o Hermes; não precisa de o instalar.
- O Git é opcional, para cópias de segurança: https://git-scm.com
- Não são necessárias linguagens de programação para usar o próprio Obi-I.

## Instalar

Este repositório é privado por enquanto; as versões chegam mais tarde.

**a) Loja de plugins da comunidade:** em breve.

**b) Transferir do trabalhoia.com:** transfira o zip do Obi-I (contém os três ficheiros) em [trabalhoia.com](https://trabalhoia.com). Descompacte-o para a pasta `<vault>/.obsidian/plugins/obi-i/` (crie a pasta, se não existir) e depois siga os mesmos passos da instalação manual abaixo. Aqui, `<vault>` é o caminho da pasta do seu cofre (vault) do Obsidian.

**c) BRAT:** instale o plugin BRAT e depois adicione `PitbullFuzo/obi-i` como plugin beta. O BRAT instala a partir das versões no GitHub, por isso só funciona quando o repositório for público e tiver uma versão.

**d) Manual:** transfira `main.js`, `manifest.json` e `styles.css` da versão mais recente no GitHub para `<vault>/.obsidian/plugins/obi-i/` (crie a pasta). Depois, abra Definições (Settings) → Community plugins e ative **Obi-I**.

**e) Peça à sua IA para o instalar:** dê este link ao seu assistente de IA (Claude Code, Codex ou semelhante) e ele seguirá os passos: [INSTALL.pt.md](INSTALL.pt.md).

## Ajuda e feedback

Os tutoriais e um formulário de feedback estão em [trabalhoia.com](https://trabalhoia.com). Os erros também podem ser reportados como issues no GitHub, quando o repositório for público.

## Windows e macOS

- **Windows** é a plataforma testada.
- **macOS** ainda não foi testado num Mac real. O código tem ramos para macOS com testes unitários apenas; por isso, trate o macOS como não verificado.
- O Claude Code é detetado no PATH e nas localizações de instalação conhecidas no Windows e no macOS. O Codex é procurado no PATH, na pasta bin do ambiente de trabalho do Windows, nos pacotes npm do Windows, em `~/.local/bin`, `~/.npm-global/bin`, Homebrew e `/usr/local/bin`. O OpenCode é procurado na localização npm do Windows, em `~/.opencode/bin`, `~/.local/bin`, Homebrew e `/usr/local/bin`. O Hermes é procurado no PATH, em `%LOCALAPPDATA%/hermes/bin`, no seu ambiente virtual de instalação e nas localizações comuns do macOS e da pasta pessoal.
- Se a deteção falhar numa ferramenta, Definições (Settings) → Obi-I → Runtime path override aceita o caminho completo para o seu programa.

## Privacidade e rede

- **O Obi-I não envia nada ao autor.** Sem telemetria, sem análises, sem conta e sem verificação de atualizações.
- **As ferramentas de IA falam com os seus próprios fornecedores.** Claude Code, Codex, OpenCode e Hermes são programas separados no seu computador; enviam a sua mensagem e as notas permitidas ao fornecedor com que iniciou sessão. Acesso à web e controlo do navegador estão desligados até os ativar para um agente.
- **Microsoft 365 só quando ligado.** Contacta `login.microsoftonline.com` e `graph.microsoft.com` apenas depois de ligar a sua própria app; cada envio ou alteração espera pelo seu Aprovar.
- **Navegador só quando ativado.** **Ligação de ajuda só quando clicada** (abre o seu navegador).
- **Ficheiros auxiliares junto ao `main.js`:** ao carregar, o plugin escreve `browser_mcp.cjs`, `m365_mcp.cjs` e `hermes_acp.py` na sua própria pasta (`.obsidian/plugins/obi-i/`). Pastas temporárias de execução ficam na pasta temporária do sistema e são removidas no fim.

## Segurança em palavras simples

- Os agentes escrevem apenas na sua pasta Work, mais as pastas externas que marcar para esse agente no Setup. Settings lista as pastas que permite; um agente sem nenhuma pasta marcada não tem pastas externas.
- Um projeto pode ter uma pasta Output para o seu trabalho final. Só as execuções desse projeto podem escrever lá; os rascunhos ficam em Work.
- As Definições (Settings) podem ocultar o Obi-I da pesquisa e do grafo (Excluded files do Obsidian). **Show again** desfaz isso.
- **"Read & write vault"** permite que um agente altere as suas notas. Ative-o apenas quando precisar.
- O acesso ao cofre juntamente com o acesso à web pode permitir que uma página web maliciosa engane um agente para enviar as suas notas para fora. Use o acesso à web apenas quando precisar.
- O Codex pode ler o computador inteiro, não apenas o cofre.
- O navegador usa um perfil limpo, sem sessões iniciadas. Funciona com Claude Code, Hermes, OpenCode e Codex. Para o Codex, precisa de uma caixa de seleção própria, porque o Codex também pode ler ficheiros em qualquer parte deste computador.
- **"Reorganise vault"** move notas apenas depois de rever um plano e de o aplicar. As mudanças atualizam as ligações, nada é apagado, e **"Undo last reorganisation"** repõe os ficheiros. Faça primeiro uma cópia de segurança.
- Apenas as notas (.md) são movidas. As imagens e os outros ficheiros ficam onde estão.
- **Run commands** está desativado para todos os agentes até o definir. **Allow freely** (permitir livremente) permite que um agente execute comandos como o próprio utilizador, com um aviso e uma caixa de seleção: Claude Code, OpenCode e Hermes só recebem uma ferramenta de comandos nesse caso. O Codex executa sempre os seus próprios comandos; por isso, com **Off**, os comandos ficam dentro da sua sandbox (apenas as pastas que permitir, sem internet), e **Allow freely** retira a sandbox: sem limites de pastas e com internet ativa. **Ask me each time** (apenas OpenCode e Hermes) mostra um cartão Approve ou Reject no chat do agente para cada comando; nada é executado até aprovar, nada fica memorizado, e uma execução agendada ou em ciclo espera e adiciona um item à Inbox. Claude Code e Codex não conseguem reter um comando para aprovação; por isso, têm apenas **Off** e **Allow freely**.
- Os custos de IA vêm dos seus próprios planos. Os limites de custo dos projetos ajudam, mas verifique o painel do seu fornecedor.
- Faça uma cópia de segurança do seu cofre antes de dar aos agentes acesso de escrita ou de reorganizar notas.

## Detalhes técnicos

Os detalhes técnicos (configuração de desenvolvimento, controlo do navegador, Hermes, OpenCode e Codex) não estão traduzidos. Os detalhes técnicos estão em inglês no [README.md](README.md).

## Aviso legal

O Obi-I permite que agentes de IA leiam e alterem os ficheiros que autorizar. É fornecido tal como está, sem garantia. Não nos responsabilizamos por perda de dados nem por custos de IA. Faça uma cópia de segurança do seu cofre (vault) antes de dar acesso de escrita aos agentes ou de reorganizar notas.

## Licença

MIT. Ver [LICENSE](LICENSE).
