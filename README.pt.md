# Mesa AI

[![Latest release](https://img.shields.io/github/v/release/PitbullFuzo/Mesa?label=release&color=7c3aed)](https://github.com/PitbullFuzo/Mesa/releases/latest) [![Downloads](https://img.shields.io/github/downloads/PitbullFuzo/Mesa/total?color=7c3aed)](https://github.com/PitbullFuzo/Mesa/releases) [![Licence: MIT](https://img.shields.io/badge/licence-MIT-7c3aed)](LICENSE) ![Desktop only](https://img.shields.io/badge/Obsidian-desktop-7c3aed) ![Works with](https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenCode%20%C2%B7%20Hermes-555)

🇬🇧 [Read in English](README.md)

**A sua própria equipa de IA, a trabalhar dentro do seu cofre (vault).** O Mesa transforma as suas notas numa pequena
empresa de agentes de IA: um CEO que planeia e delega, especialistas que fazem o trabalho e revisores que o verificam.
Conversa com eles, dá-lhes projetos, põe-nos a trabalhar com horários e decide exatamente o que cada um pode tocar.
O seu assistente **Obi** mostra-lhe tudo e pode preparar as coisas por si.

O Mesa funciona com as ferramentas de IA que já tem: **Claude Code, Codex, OpenCode (incluindo modelos gratuitos) ou
Hermes**, com as suas próprias contas e planos. Nada passa por um servidor do Mesa, porque não existe nenhum.

Feito por Marcio Vieira — guias, tutoriais, transferências e feedback em [trabalhoia.com](https://trabalhoia.com).

## O que pode fazer com ele

### Montar uma equipa que trabalha em conjunto

- **Um organograma editável.** Os agentes são notas com uma função, instruções, um responsável e a sua própria
  ferramenta e modelo de IA. Arraste-os no AI Graph, agrupe-os em equipas e envie difusões para todos ou para um grupo.
- **Delegação.** Peça algo grande ao CEO: ele divide o trabalho, distribui-o pela equipa e traz os resultados.
- **Revisores e ciclos de verificação.** Um revisor verifica o trabalho e devolve-o com sugestões até ficar aprovado —
  recebe resultados acabados, não primeiros rascunhos.
- **Misture ferramentas de IA na mesma equipa:** um escritor com Claude Code, um programador com Codex e um
  investigador gratuito com OpenCode.

### Conheça o Obi, o seu assistente

- Uma **visita guiada**, um guia em linguagem simples e a página **"Check my setup"**, que mostra que ferramentas estão prontas.
- Peça ao Obi para criar agentes, equipas, projetos ou horários: cada alteração aparece primeiro como um cartão
  **Aprovar / Rejeitar**.

### Projetos com memória

- Os **projetos** dão aos agentes um objetivo, instruções, competências (skills) e **memória**: decisões e factos ficam
  guardados em notas e os relevantes são lembrados automaticamente — não precisa de se repetir.
- Um **quadro do projeto** mostra quem faz o quê; **limites de custo** param um projeto antes de gastar mais do que permite.

### Trabalho em piloto automático

- **Horários:** "Todas as manhãs, resume as notas das reuniões de ontem", "Todas as sextas, prepara o relatório
  semanal". Corre enquanto o Obsidian está aberto.
- **Ciclos (🔁):** repetem uma tarefa até o revisor ficar satisfeito ou até um número de vezes — ótimo para "melhora isto
  até ficar bom" ou pesquisa em várias passagens.
- Tudo o que precisa da sua decisão espera na **Inbox**.

### Notas organizadas

- **Destinos de notas:** deixe um agente escrever **atas de reuniões, pesquisa, páginas de wiki e notas permanentes
  (Zettelkasten)** diretamente nas suas pastas, com modelos e `[[ligações]]`, para aparecerem nas suas notas e no grafo.
- **Reorganizar o cofre:** um agente propõe uma estrutura de pastas mais arrumada; revê o plano, aplica-o mantendo as
  ligações e pode desfazê-lo com um clique. Nada é apagado.
- **Visão geral do grafo:** um grafo de pontos vivo, ao estilo do Obsidian, colorido por grupos, com notas centrais,
  pontes e notas soltas.

### Poupar tokens de IA

- Um **mapa do cofre** e um **mapa do grafo** levam os agentes diretamente às notas certas, sem pesquisar o cofre inteiro.
- A **pesquisa no cofre** e a **memória de conversas** juntam apenas os excertos relevantes.
- Uma **barra de contexto** e, no Claude Code, um **medidor do plano** ("5h 11% · week 42%") mostram o que está a usar.

### Agentes que agem — com segurança

- **Controlo do navegador** em todas as ferramentas de IA, num navegador limpo e sem sessões iniciadas.
- **Run commands:** desligado, **Ask me each time** (um cartão de aprovação para cada comando) ou **Allow freely** — por agente.
- **Microsoft 365:** ler o correio do Outlook, o calendário e o OneDrive; preparar rascunhos; **enviar, apagar ou
  partilhar espera sempre pelo seu cartão Aprovar**. Basta carregar em Sign in.
- **Pastas externas, pastas de resultados dos projetos e acesso ao cofre** são ativados por agente, nunca por omissão.

### Um chat à sua medida

- **Editar a seleção com um agente:** selecione texto (ou clique com o botão direito e escolha Edit with an agent…), dê uma instrução, veja a pré-visualização (frases alteradas lado a lado, ou Antes e Depois quando quase tudo mudou) e
  depois Aceite ou Rejeite.
- **Menções com @** para anexar notas, pastas ou o chat de outro agente; **📎** anexa a nota aberta.
- **Comandos com barra:** `/new`, `/fork`, `/compact`, `/skill`, `/project`, `/side` (uma pergunta rápida à parte, sem
  mexer no chat principal) e `/help`.
- Imagens no chat, histórico, bifurcações (fork), blocos de código recolhíveis e janelas separadas para mais agentes.

## O que precisa

- Obsidian desktop, em Windows ou Mac: https://obsidian.md
- Pelo menos uma ferramenta de IA, instalada e com sessão iniciada:
  - Claude Code (um plano Claude ou uma chave de API): https://code.claude.com/docs/en/setup
  - Codex CLI (um plano ChatGPT; versão 0.160.0 ou mais recente): https://github.com/openai/codex
  - OpenCode (versão 1.19.1 ou mais recente; tem modelos gratuitos): https://opencode.ai
  - Hermes (ver o [README.md](README.md) em inglês)
- Node.js, apenas para o controlo do navegador: https://nodejs.org
- Git é opcional, para cópias de segurança: https://git-scm.com
- Não precisa de programar. Execute **"Mesa: Check my setup"** (Ctrl/Cmd+P) para ver o que está pronto.

## Instalar

A pasta do plugin chama-se obi-i (o seu ID original); o plugin é o Mesa.

- **Community plugins (recomendado):** Obsidian → Definições → Community plugins → Browse → procure **Mesa** → Install → Enable.
- **Transferir do trabalhoia.com:** descompacte o zip do Mesa (três ficheiros) para `.obsidian/plugins/obi-i/` dentro da
  pasta do seu cofre e ative o Mesa em Definições → Community plugins.
- **BRAT:** adicione `PitbullFuzo/Mesa` como plugin beta.
- **Manual:** transfira `main.js`, `manifest.json` e `styles.css` da
  [versão mais recente](https://github.com/PitbullFuzo/Mesa/releases/latest) para `.obsidian/plugins/obi-i/` dentro da
  pasta do seu cofre e ative o Mesa.
- **Peça à sua IA para o instalar:** dê ao seu assistente de IA o [INSTALL.pt.md](INSTALL.pt.md).

Depois abra o Mesa pelo ícone na barra lateral: o Obi oferece a visita guiada e uma equipa inicial (CEO, Coder,
Reviewer) está pronta para conversar.

## Segurança em palavras simples

- **Os agentes começam fechados.** Por omissão, um agente só escreve na sua própria pasta Work. Acesso ao cofre, acesso
  à web, controlo do navegador, comandos, destinos de notas, pastas externas e Microsoft 365 são ativados por agente,
  com um aviso quando importa.
- **As pastas do próprio Mesa estão protegidas** dos agentes, e o Obi não pode aumentar as suas próprias permissões nem
  os limites de custo.
- **Ações para fora ou destrutivas esperam por si:** enviar email, apagar, partilhar e (com "Ask me each time") cada
  comando mostram um cartão Aprovar com todos os detalhes.
- **O Codex pode ler o computador inteiro**, por isso precisa do seu consentimento explícito e tem avisos extra.
- Um agente com acesso ao cofre e à web pode ser enganado por uma página maliciosa para divulgar notas — use o acesso à
  web só quando precisar.
- Os custos de IA vêm dos seus próprios planos; os limites de custo ajudam, mas verifique o painel do seu fornecedor.
- **Faça uma cópia de segurança do cofre** antes de dar acesso de escrita aos agentes ou de reorganizar notas.

## Privacidade e rede

- **O Mesa não envia nada ao autor.** Sem telemetria, sem análises, sem conta e sem verificação de atualizações.
- **As ferramentas de IA falam com os seus próprios fornecedores**, com a sua mensagem e as notas que permitir.
- **Microsoft 365 só quando ligado**; **navegador só quando ativado**; **a ligação de ajuda só quando clicada**.
- **Porque lista os ficheiros do cofre:** os mapas, a visão geral, a pesquisa e o organizador precisam da lista das suas
  notas e ligações. Fica no seu computador; um agente só a vê com acesso ao cofre.
- Ao carregar, o plugin escreve três ficheiros auxiliares na sua própria pasta. O código é aberto (MIT).

## Ajuda e feedback

Tutoriais e um formulário de feedback em [trabalhoia.com](https://trabalhoia.com). Erros e ideias:
[GitHub issues](https://github.com/PitbullFuzo/Mesa/issues).

## Apoiar o Mesa AI

O Mesa AI é gratuito e tem licença MIT. Se lhe poupar tempo, pode [pagar-me um café no Ko-fi](https://ko-fi.com/marciovieira).
Obrigado!

## Detalhes técnicos

Os detalhes técnicos (cada ferramenta de IA, onde ficam os ficheiros, desenvolvimento e versões assinadas pelo GitHub
Actions) estão em inglês no [README.md](README.md).

## Aviso legal

O Mesa permite que agentes de IA leiam e alterem os ficheiros que autorizar. É fornecido tal como está, sem garantia. Não nos responsabilizamos por perda de dados nem por custos de IA. Faça uma cópia de segurança do seu cofre (vault) antes de dar acesso de escrita aos agentes ou de reorganizar notas.

## Licença

MIT. Ver [LICENSE](LICENSE).
