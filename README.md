# ClickUp Tasks

Importa uma tarefa do ClickUp (dados, campos personalizados, checklists, subtarefas, comentários e links dos anexos) para uma pasta local, em Markdown. Para trabalhar com IA, é só referenciar o `task.md` no chat do Copilot, Claude Code, Codex ou qualquer outra.

## Uso

1. `Ctrl+Shift+P` → **ClickUp: Token da API** e cole o seu token pessoal (ClickUp → Settings → Apps → API Token, começa com `pk_`). Ele é validado na hora e fica guardado no keychain do sistema. Rodando o mesmo comando de novo, você vê a conta conectada e pode trocar ou remover o token.
2. Clique no ícone **ClickUp Tasks** na Activity Bar e no botão **+** (ou `Ctrl+Shift+P` → **ClickUp: Nova tarefa**). Aceita:
   - ID customizado: `ID-49228` (maiúsculas ou minúsculas, com hífen ou espaço)
   - Só o número: `49228` → tenta `ID-49228` e depois como ID nativo (prefixos em `clickupTasks.numericIdPrefixes`)
   - Hash (ID nativo): `17twvjwwqeu` ou `#17twvjwwqeu`
   - Link: `https://app.clickup.com/t/...`
3. **Clicar numa tarefa** da lista abre o painel da tarefa: um cabeçalho no estilo do ClickUp (status, prioridade, tags, responsáveis, criador, tempo rastreado × estimativa, início, prazo — destacado se atrasado —, criação/atualização/conclusão, pontos, observadores, lista) e as abas **Descrição** (texto, campos personalizados, checklists, subtarefas e galeria de anexos), **Comentários** (do ClickUp) e **🔒 Notas locais**. O `task.md` continua sendo gerado para referenciar em IAs (botão **task.md** no painel ou botão direito → **Abrir task.md**). Ao importar uma tarefa nova, o painel abre automaticamente. O botão 💬 da tarefa abre os **comentários** numa tela própria: cards por autor, agrupados por dia, respostas em thread, imagens, busca, ordem invertível e botão para atualizar do ClickUp. No rodapé dessa tela dá para **comentar** e **responder** comentários direto no ClickUp, com `**negrito**`, `_itálico_`, `` `código` ``, links e `@menção` com autocompletar — atalhos `Ctrl+B`, `Ctrl+I`, `Ctrl+E` e `Ctrl+K` (ou os botões **B** *I* `</>` 🔗) aplicam/removem o formato no texto selecionado. Se o ClickUp recusar a formatação, o comentário é reenviado como texto puro. A aba **🔒 Notas locais** (separada dos comentários) guarda anotações que **não vão para o ClickUp**: o editor dessa aba cria notas em vez de comentar; elas aparecem com borda tracejada, têm data (escolhida ou a atual), podem ser editadas e excluídas, ficam em `notes.json` e numa seção **Notas locais** do `task.md` (para a IA também ver). Elas sobrevivem à atualização da tarefa. A lista lateral agrupa as tarefas por **status**, na ordem e com as cores do ClickUp (concluídas por último, recolhidas; o menu **…** do painel alterna para lista simples e tem recarregar e token). No topo do painel ficam **+ nova tarefa**, **🔍 pesquisar** (filtra enquanto digita, por termos do título ou pelo ID: `49228` ou `ID-49228`, sem diferenciar acentos) e **filtrar por status** (só os status que existem nas suas tarefas, com contagem, múltipla escolha). Os filtros ficam salvos por workspace e o botão de limpar aparece quando há filtro ativo. Cada tarefa tem botão **▶ iniciar timer** do ClickUp (vira **■ parar** na tarefa que está contando, marcada com ● vermelho e ⏱). Como o ClickUp só permite um timer por pessoa, iniciar numa tarefa para o que estiver rodando em outra, inclusive um timer iniciado no ClickUp web. O tempo corre na barra de status (clique para parar) e a extensão sincroniza com o ClickUp a cada minuto e ao focar a janela. Ao passar o mouse, cada tarefa mostra ▶/■ timer, comentários e **alterar status** (mostra os status da lista da tarefa no ClickUp). O botão direito tem também **baixar/limpar imagens**, atualizar do ClickUp, abrir a pasta, abrir no ClickUp e **remover tarefa local**, que manda a pasta para a lixeira sem alterar nada no ClickUp.

## Estrutura gerada

```
.clickup/tasks/
├── .gitignore            # "*": se a pasta ficar dentro de um projeto, não entra no git
└── ID-49228/
    ├── task.md           # tarefa legível; imagens e anexos como link do ClickUp
    ├── task.json         # resposta bruta da API
    ├── comments.json
    ├── notes.json        # notas locais (só existe se você criar alguma)
    └── images/           # só se você usar "Baixar imagens"; apagada sozinha em 3 h
```

### Imagens e anexos

Por padrão nada é baixado: imagens, vídeos e arquivos ficam como link do ClickUp.

- **Botão direito na tarefa → Baixar imagens**: baixa **só as imagens** para `<tarefa>/images/` (vídeos e outros arquivos **nunca** são baixados). A partir daí a descrição (no `task.md` e no painel) usa os arquivos locais, e clicar numa imagem a **amplia no VS Code**: no painel, com zoom (roda do mouse, arrastar, duplo clique, `Esc`); no preview do `task.md`, no visualizador de imagens.
- **Sem imagens baixadas**, a descrição mostra as imagens pelo link e clicar **abre no navegador** (com `?view=open`, para exibir em vez de baixar).
- As imagens baixadas ficam em `<pasta das tarefas>/<ID>/images/<id-do-anexo>_<nome>` (ex.: `~/Documentos/Vertti/ClickUp/tarefas/ID-49228/images/691e8152_image.png`). A barra da aba **Descrição** mostra a pasta e tem **Abrir pasta**.
- **Botão direito numa imagem do painel**: **Copiar caminho da imagem** e **Abrir em aba do VS Code** (imagens baixadas), **Copiar link da imagem** e **Abrir no navegador** (sempre).
- **Botão direito → Limpar imagens** apaga as imagens da tarefa na hora e a descrição volta aos links.
- **Limpeza automática**: em todas as tarefas, cada imagem baixada é apagada **3 horas** depois do download (`clickupTasks.imageRetentionHours`; verificação a cada 15 min). O `task.md` e o painel voltam aos links sozinhos.
- Na aba **Descrição** do painel há uma barra com o estado das imagens e os mesmos botões Baixar/Limpar.

## Configurações

| Chave | Padrão | Descrição |
| --- | --- | --- |
| `clickupTasks.tasksFolder` | `.clickup/tasks` | Relativo ao workspace, absoluto ou `~/...`. Com caminho fixo, todas as janelas compartilham as tarefas e a lista se atualiza sozinha em todas |
| `clickupTasks.teamId` | _(auto)_ | Workspace do ClickUp, necessário para IDs customizados |
| `clickupTasks.numericIdPrefixes` | `["ID"]` | Prefixos tentados quando você digita só o número |
| `clickupTasks.groupByStatus` | `true` | Agrupar a lista por status |
| `clickupTasks.imageRetentionHours` | `3` | Horas até apagar sozinhas as imagens baixadas (todas as tarefas) |

## Desenvolvimento

```bash
npm install
npm run compile      # type-check + build em dist/
npm run watch        # rebuild contínuo
npm run package      # gera clickup-tasks-<versão>.vsix
code --install-extension clickup-tasks-0.1.0.vsix
```

Para depurar, abra esta pasta no VS Code e aperte **F5**.
