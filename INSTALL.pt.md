# Instalar o Mesa (instruções para um assistente de IA)

> Este repositório é privado por enquanto; as versões chegam mais tarde.

É um assistente de IA (Claude Code, Codex ou semelhante). O utilizador deu-lhe esta página para
instalar o plugin Mesa do Obsidian. Siga estes passos por ordem. Pergunte ao utilizador
sempre que um passo exija uma decisão.

1. **Pergunte qual é o cofre.** Peça ao utilizador o caminho completo da pasta do cofre (vault)
   do Obsidian onde instalar. Nunca o adivinhe. Nunca toque noutro cofre nem noutra pasta.

2. **Transfira três ficheiros.** Transfira `main.js`, `manifest.json` e `styles.css` da versão
   mais recente em https://github.com/PitbullFuzo/Mesa (ou o zip do Mesa em
   https://trabalhoia.com, se o utilizador lhe der esse link; contém os mesmos três ficheiros)
   para `.obsidian/plugins/obi-i/` dentro da pasta do seu cofre (a pasta chama-se obi-i, o ID original; o plugin é o Mesa). Crie essa pasta se não existir. Não transfira mais
   nada. Não execute nenhum ficheiro transferido.

3. **Não altere as definições do Obsidian.** Não edite `community-plugins.json`, a definição de
   modo restrito, `app.json` nem qualquer outro ficheiro de definições do Obsidian. Em vez disso,
   diga ao utilizador:
   - Abra Definições (Settings) → Community plugins.
   - Se o Obsidian perguntar, desative o **Restricted mode**.
   - Ative o **Mesa** manualmente.

4. **Verifique a instalação.** Diga ao utilizador para premir Ctrl+P (Cmd+P no Mac), executar
   **"Mesa: Check my setup"** e ler quais as ferramentas de IA que estão prontas. Depois, diga-lhe
   para fazer a visita guiada do Obi dentro do Mesa.

5. **Recomende uma cópia de segurança.** Antes de o utilizador dar acesso de escrita a qualquer
   agente, diga-lhe para fazer uma cópia de segurança do cofre. Indique o aviso legal:
   https://github.com/PitbullFuzo/Mesa/blob/main/README.pt.md#aviso-legal
