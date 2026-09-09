# Sistema de Empenho — SEDUC

Duas telas:

1. **Empenho** — importa a planilha, separa os itens por **Fonte** de recurso, permite
   definir um **teto orçamentário** por fonte e dá baixa item a item por *checkbox*,
   abatendo o valor do teto em tempo real.
2. **Importe** — recebe os **dois documentos** da competência e cruza um com o outro:
   o que tem que ser pago × o que a folha efetivamente pagou, grupo a grupo.

---

## Stack

| Camada    | Tecnologia |
|-----------|------------|
| Backend   | Node.js 22+ · Express |
| Banco     | SQLite (`node:sqlite`) no desenvolvimento · **PostgreSQL** em produção |
| PDF       | `pdfjs-dist` — extração de texto com coordenadas |
| Planilhas | SheetJS (`xlsx`) para XLSX/XLS · parser próprio para CSV (`;`, aspas, Latin-1) |
| Frontend  | HTML + CSS + JavaScript puro (sem build, sem framework) |

## Como rodar

```bash
npm install
npm start
```

Acesse **http://localhost:3000** (mude a porta com `PORT=8080 npm start`).

Sem configurar nada, o sistema usa SQLite em `data/empenho.db`. Se existir a variável
`DATABASE_URL`, ele usa PostgreSQL — é o que acontece na Vercel. Para conferir qual banco
está ativo: `GET /api/saude`.

Para gerar uma planilha de teste no formato típico da folha:

```bash
npm run exemplo
```

O arquivo sai em `data/exemplo-folha.xlsx` (120 linhas, 5 fontes, com linha de título
e linha de "TOTAL GERAL" — que o sistema ignora automaticamente).

---

## Estrutura

```
seduc-sistema/
├── server.js                 # API REST (Express) — exporta o app
├── db.js                     # camada de dados: SQLite (local) ou Postgres (produção)
├── api/index.js              # ponto de entrada da Vercel (função serverless)
├── vercel.json               # roteamento /api/* -> função
├── lib/
│   ├── parser.js             # leitura de XLSX/CSV e detecção de colunas
│   ├── parser-padrao.js      # leitura da planilha padrão (uma aba por fonte)
│   ├── parser-folha.js       # Importação 1 — relatório da folha (PDF)
│   ├── parser-empenho.js     # Importação 2 — documento de empenho (PDF/XLSX)
│   ├── posicao-pdf.js        # leitura de PDF preservando a posição do texto
│   ├── grupos.js             # os 67 grupos oficiais e o casamento por nome cortado
│   ├── importe.js            # gravação das duas importações e a consolidação
│   └── util.js               # normalização de texto e conversão de valores
├── public/                   # interface (servida como estático)
│   ├── index.html
│   ├── styles.css
│   ├── app.js                # tela de empenho
│   ├── importe.js            # aba Importe
│   └── mapeamento.js         # tela de mapeamento manual de colunas
├── scripts/
│   ├── gerar-planilha-exemplo.js
│   └── migrar-para-postgres.js
└── data/                     # banco SQLite (empenho.db) e planilhas de exemplo
```

---

## Esquema do banco

Todos os valores monetários são gravados em **centavos (INTEGER)** — soma de dinheiro
em ponto flutuante acumula erro de arredondamento, o que é inaceitável em empenho.

### `fontes` — catálogo de fontes e teto orçamentário

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | INTEGER PK | |
| `nome` | TEXT | como veio na planilha (ex.: `Salário Educação`) |
| `nome_normalizado` | TEXT UNIQUE | sem acento/caixa — evita duplicar "FUNDEB 60%" e "Fundeb 60%" |
| `codigo` | TEXT UNIQUE | código da fonte na planilha padrão (`1540107043`) — é a identidade |
| `titulo` | TEXT | título lido da primeira linha da aba (`IMPOSTOS – 70% - PESSOAL`) |
| `meta_centavos` | INTEGER | `Valor-meta da fonte`, como veio da planilha |
| `teto_centavos` | INTEGER | limite em uso (nasce igual à meta; editável na tela) |
| `criado_em` / `atualizado_em` | TEXT | |

As fontes são criadas automaticamente na importação; o teto é definido na tela.

### `arquivos` — cada planilha importada (lote)

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | INTEGER PK | |
| `nome_original` | TEXT | nome do arquivo enviado |
| `competencia` | TEXT | mês de referência detectado |
| `total_linhas` | INTEGER | linhas importadas |
| `valor_total_centavos` | INTEGER | soma do lote |
| `enviado_em` | TEXT | |

Excluir um arquivo remove suas linhas (as fontes e os tetos permanecem).

### `linhas` — cada linha da planilha

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | INTEGER PK | |
| `arquivo_id` | FK → `arquivos` | lote de origem |
| `fonte_id` | FK → `fontes` | **separação por fonte** |
| `linha_planilha` | INTEGER | número da linha no arquivo original (rastreabilidade) |
| `grupo` | TEXT | grupo/nível, propagado do cabeçalho de seção da planilha |
| `codigo` | TEXT | código da despesa (`319011`) |
| `descricao` | TEXT | **Ação/Despesa** no formato padrão; descrição da verba no formato plano |
| `acao` | TEXT | código da ação (`283508`) |
| `plano_interno` | TEXT | plano interno (`4110028339P`) |
| `matricula`, `nome`, `cargo`, `lotacao`, `competencia` | TEXT | campos do formato plano |
| `valor_centavos` | INTEGER | valor do item |
| `empenhado` | INTEGER | 0 = pendente · 1 = empenhado (o *checkbox*) |
| `empenhado_em`, `empenhado_por` | TEXT | quando e por quem |
| `dados_extra` | TEXT (JSON) | colunas da planilha que não foram mapeadas — nada se perde |

Índices: `fonte_id`, `arquivo_id` e `(fonte_id, empenhado)` — este último atende
direto às somas de "empenhado por fonte".

### `movimentos` — auditoria

Cada marcação e desmarcação grava `EMPENHO` ou `ESTORNO` com valor, usuário e data.
É o histórico que a planilha manual não tinha.

### Como o saldo é calculado

Não existe coluna "saldo" gravada — ela é sempre derivada, o que impede divergência:

```sql
empenhado = SUM(valor_centavos) WHERE empenhado = 1
saldo     = fontes.teto_centavos - empenhado
```

---

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/arquivos` | upload multipart (`arquivo`) — detecta o formato, processa e grava |
| `GET` | `/api/arquivos` | lotes importados |
| `DELETE` | `/api/arquivos/:id` | remove o lote e suas linhas |
| `GET` | `/api/fontes` | fontes com teto, total, empenhado e saldo |
| `PUT` | `/api/fontes/:id/teto` | define o teto (`{"teto":"20.000,00"}` ou `{"tetoCentavos":2000000}`) |
| `GET` | `/api/fontes/:id/linhas` | itens **só daquela fonte** + `formato` + `colunas` — filtros `status=pendentes\|empenhados`, `busca` (texto **ou valor**), `arquivoId` |
| `POST` | `/api/empenhos` | empenha/estorna: `{"ids":[1,2],"empenhado":true,"forcar":false}` |
| `GET` | `/api/resumo` | totais consolidados |
| `GET` | `/api/fontes/:id/export.csv` | exporta a fonte com o status de cada item |
| `GET` | `/api/saude` | diagnóstico: qual banco está ativo e quantas fontes existem |

`/api/arquivos` aceita um **mapeamento manual** opcional, usado quando o reconhecimento automático não acerta:

```json
{ "indiceLinha": 3, "mapa": { "fonte": 3, "valor": 5, "nome": 1, "matricula": 0 } }
```

`indiceLinha` é a linha do cabeçalho (base 0) e cada valor do `mapa` é o índice da
coluna. Quando a detecção falha, a resposta `422` traz `codigo:
"COLUNAS_NAO_IDENTIFICADAS"` e uma `amostra` com as 30 primeiras linhas lidas — é ela
que alimenta a tela de mapeamento.

### Busca

Um único campo procura em tudo: texto e valor.

**Texto** — nome, matrícula, cargo, lotação, competência, grupo, código, ação e plano
interno. A comparação usa a coluna `linhas.busca_texto`, que guarda esses campos
concatenados **sem acento e em caixa alta**. Isso existe porque o `UPPER()` do SQLite só
entende ASCII: sem essa coluna, procurar por `Auxílio` nunca acharia `AUXÍLIO`. A coluna
é preenchida na importação, e o servidor completa na subida as linhas gravadas antes dela
existir.

**Valor** — `1.500,00`, `1500,00` e `1500` acham R$ 1.500,00. São duas comparações:
igualdade exata em centavos e "contém" sobre o valor formatado, então `500` também traz
R$ 1.500,00 e R$ 4.500,00. As condições de valor só entram quando o termo tem algum
dígito — sem esse cuidado, uma busca por texto puro casaria com `valor_centavos = 0` e
traria todos os itens sem valor alocado.


### Controle de teto

A validação é feita **no servidor** (o navegador não é fonte de verdade). Se a marcação
ultrapassar o teto da fonte, a resposta é `409` com o detalhamento:

```json
{
  "erro": "TETO_EXCEDIDO",
  "mensagem": "Esta ação ultrapassa o teto da fonte \"Salário Educação\".",
  "necessarioCentavos": 9287945,
  "saldoCentavos": 1815567,
  "excedenteCentavos": 7472378
}
```

A interface mostra esses números e pergunta se deve empenhar mesmo assim; em caso
afirmativo reenvia com `forcar: true`, e a fonte passa a exibir saldo negativo em
vermelho (na aba, no medidor e no resumo). Ou seja: o teto **avisa e registra**, não
trava a operação — a decisão continua sendo da operadora.

---

## Planilha padrão — uma aba por Fonte

É o formato principal do sistema. A detecção é automática: se alguma aba começa com
`FONTE …` na primeira linha e traz o cabeçalho de colunas logo abaixo, o arquivo entra
por este caminho (`lib/parser-padrao.js`); caso contrário cai no leitor de planilha
plana. Não há nada para o usuário escolher.

### Estrutura lida de cada aba

```
linha 0   FONTE 1540107043 – IMPOSTOS – 70% - PESSOAL          <- título da aba na UI
linha 1   160102 – FUNDEB – SEDUC – FOLHA:08/2026 – Nº1 | …    <- contexto (competência)
linha 2   (em branco)
linha 3   GRUPO/NÍVEL | CÓDIGO | AÇÃO/DESPESA | AÇÃO | VALOR | PLANO INTERNO | FONTE
linha 4   ADMINISTRATIVO / ADMINISTRATIVO / ADMINISTRATIVO      <- linha de grupo
linha 5           | 319004 | Contratação… | 283508 | 972701.85 | 4110028339P | 1540107043
…
          TOTAL ALOCADO NESTA FONTE  ||||  146472259.69
          RESUMO DA FONTE
          Fonte                      | 1540107043
          Valor-meta da fonte        | 146472259.69     <- vira o TETO da fonte
          Total dos valores alocados | 146472259.69
          Diferença (Meta - Alocado) | 0
          Status                     | META ATINGIDA
```

Quatro decisões de leitura que importam:

1. **Título da aba** — sai da primeira linha. `FONTE 1540107043 – IMPOSTOS – 70% - PESSOAL`
   vira `codigo: "1540107043"` + `titulo: "IMPOSTOS – 70% - PESSOAL"`. A aba da interface
   mostra o título; o código aparece como etiqueta ao lado e é o que identifica a fonte
   no banco — título pode mudar de competência para competência sem virar outra fonte.
2. **Grupo vira coluna** — na planilha o grupo é um cabeçalho de seção (linha com só a
   primeira célula preenchida). Como a regra pede o Grupo *como coluna da tabela*, ele é
   propagado para todos os itens abaixo dele até aparecer o próximo grupo.
3. **Rodapé não é dado** — `TOTAL ALOCADO NESTA FONTE` e o bloco `RESUMO DA FONTE` são
   lidos como metadados, não como itens.
4. **O teto vem pronto** — `Valor-meta da fonte` é gravado como `meta_centavos` **e** como
   `teto_centavos`. Não é preciso digitar teto nenhum: ao importar, cada aba já chega com
   seu limite orçamentário. O campo continua editável na tela.

Como conferência, a soma dos itens é comparada com o `TOTAL ALOCADO NESTA FONTE` da
própria planilha; divergência vira aviso na resposta da importação. Itens sem valor
alocado (célula VALOR vazia) são importados com R$ 0,00 e contados à parte.

### JSON enviado ao frontend

`GET /api/fontes` — monta as abas:

```json
[
  {
    "id": 1,
    "codigo": "1540107043",
    "titulo": "IMPOSTOS – 70% - PESSOAL",
    "nome": "IMPOSTOS – 70% - PESSOAL",
    "metaCentavos": 14647225969,
    "tetoCentavos": 14647225969,
    "totalItens": 146,
    "totalCentavos": 14647225969,
    "itensEmpenhados": 0,
    "empenhadoCentavos": 0,
    "pendenteCentavos": 14647225969,
    "saldoCentavos": 14647225969,
    "estourouTeto": false
  }
]
```

`GET /api/fontes/:id/linhas` — monta a tabela daquela fonte, e só dela:

```json
{
  "fonte": { "id": 1, "codigo": "1540107043", "titulo": "IMPOSTOS – 70% - PESSOAL", "…": "…" },
  "formato": "orcamento",
  "colunas": [
    { "chave": "grupo",       "rotulo": "Grupo" },
    { "chave": "codigo",      "rotulo": "Código" },
    { "chave": "acaoDespesa", "rotulo": "Ação/Despesa" },
    { "chave": "acao",        "rotulo": "Ação" },
    { "chave": "valor",       "rotulo": "Valor", "tipo": "moeda" },
    { "chave": "planoInterno","rotulo": "Plano Interno" },
    { "chave": "fonte",       "rotulo": "Fonte" }
  ],
  "linhas": [
    {
      "id": 1,
      "linhaPlanilha": 6,
      "grupo": "ADMINISTRATIVO / ADMINISTRATIVO / ADMINISTRATIVO",
      "codigo": "319004",
      "acaoDespesa": "Contratação Por Tempo Determinado",
      "acao": "283508",
      "valorCentavos": 97270185,
      "planoInterno": "4110028339P",
      "fonte": "1540107043",
      "empenhado": false,
      "empenhadoEm": null
    }
  ]
}
```

O array `colunas` é o contrato de exibição: o frontend monta cabeçalho e células
percorrendo essa ordem, sem nomes de coluna escritos no código da tela. É por isso que a
**Fonte é sempre a última coluna** — ela é a última do array, definido no servidor
(`lib/parser-padrao.js` → `COLUNAS`). Valores monetários trafegam em centavos (inteiro)
e são formatados só na hora de exibir.

Quando a fonte veio de uma planilha plana (formato antigo), `formato` vem como `"folha"`,
`colunas` vem `null` e a tela usa o conjunto Servidor/Matrícula/Lotação/Descrição/Valor.

---

## Leitura da planilha (formato plano)

O importador foi feito para a realidade dos arquivos da folha:

- **Cabeçalho em qualquer linha** — procura nas 25 primeiras a linha que tenha
  "Fonte" e "Valor"; linhas de título e brasão acima são ignoradas.
- **Sinônimos de coluna** — `Fonte`, `Fonte de Recurso`, `Cód. Fonte`…;
  `Valor`, `Valor Líquido`, `Vlr Total`…; `Nome`, `Nome do Servidor`, `Servidor`…
  (preposições são descartadas na comparação). A lista fica em `lib/parser.js` → `ALIASES`.
- **Valores em qualquer formato** — `1.234,56`, `R$ 1.234,56`, `1234.56`, `(500,00)` (negativo).
- **CSV brasileiro** — detecta o separador (`;`, `,`, tab, `|`) e decodifica
  Windows-1252 quando o arquivo não é UTF-8.
- **Linhas de `TOTAL` / `SUBTOTAL` são descartadas** para não dobrar o somatório.
- Colunas não reconhecidas vão para `dados_extra` em JSON.

### Fonte "Não identificada"

Relatório em PDF costuma trazer, na mesma coluna da fonte, coisas que não são fonte:
rodapé (`Página: 1/5`), linha de `SALDO`, o próprio somatório (`35.094.246,46`), traços
e `#`. Sem tratamento, cada um desses textos virava uma **fonte nova** no sistema.

Agora essas linhas vão todas para uma única fonte chamada **`Não identificada`**, que
aparece destacada em laranja nas abas. Nada é descartado em silêncio: o texto original
da coluna fica guardado em `dados_extra` (`"Fonte (não reconhecida)"`), e a operadora
revisa o que caiu ali antes de empenhar.

O critério está em `lib/parser.js` → `fonteReconhecivel()`. É recusado o que:

- começa com `SALDO`, `TOTAL`, `PÁGINA`, `FOLHA`, `RESUMO`, `LÍQUIDO`…;
- não tem nenhuma letra ou dígito (`#`, `-`, `---`);
- tem cara de dinheiro (`35.094.246,46`, `(35.094.246,46)`, `1389726.59`) — repare que
  **código de fonte inteiro passa** (`1500100102`, `101`), porque fonte não tem centavos;
- é só zero.

Linhas sem fonte **e** sem valor continuam sendo ignoradas: não carregam informação.

### Limpeza de fontes vazias

Fontes que ficaram sem nenhum item e sem teto (resíduo de importação corrigida ou de
planilha excluída) aparecem no rodapé da tela de empenho com um botão **Remover fontes
vazias**. Fontes com teto definido nunca entram nessa lista.

Ao final do upload a tela mostra qual coluna da planilha virou qual campo, quantas
linhas entraram e quantas foram ignoradas.

### Quando o reconhecimento automático não acerta

Nenhuma lista de sinônimos cobre todo relatório. Se o arquivo usar abreviações como
`FR`, `Vl. Líq.` ou `Cad.`, o sistema **não desiste**: abre a tela de **mapeamento
manual**, mostrando as primeiras linhas exatamente como foram lidas. Ali a operadora:

1. clica na linha que é o cabeçalho (o sistema já dá um palpite: a linha com mais
   células preenchidas);
2. escolhe, em listas suspensas, qual coluna é a Fonte e qual é o Valor — os demais
   campos são opcionais.

A coluna de Valor costuma vir pré-selecionada mesmo sem título reconhecível, porque o
sistema procura a coluna cujos dados têm cara de dinheiro (`1.234,56`, `R$ 1.234,56`).

Isso vale para o upload de planilha na tela de empenho.

---

## Aba Importe — as duas importações

A aba recebe duas fontes de dados distintas e consolida uma base única a partir delas.

| | Documento | O que é | Formato |
|---|---|---|---|
| **Importação 1** | Relatório da folha (SIAFEM / PPAREL14) | o que a folha **pagou** | PDF |
| **Importação 2** | Documento de empenho | o que **tem que ser pago** | PDF ou XLSX |

Cada tipo guarda só a importação mais recente: reenviar substitui a anterior.

### A ligação entre os dois: o GRUPO

Os documentos não têm nenhuma chave em comum além do grupo
(`GRUPO / NÍVEL / MODALIDADE`). A lista oficial dos **67 grupos** está em
`lib/grupos.js` e é a espinha dorsal da consolidação — um grupo ausente nos dois
documentos ainda aparece, zerado, para não sumir da conferência.

O casamento tem uma sutileza: o relatório da folha **corta o nome do grupo** num tamanho
fixo, e o corte cai no meio da palavra —
`EDUCAÇÃO PROFISSIONAL TÉCNICA` vira `EDUC PROFIS TECNIC`, às vezes comendo a última
palavra inteira. Comparar texto com texto produzia diferenças falsas de milhões. Por isso
`casaComOficial()` compara **palavra a palavra**, cada uma do texto cortado tendo que ser
o início da palavra oficial correspondente.

### A fonte que vale

A **Importação 2** é a autoridade sobre a fonte de recurso. O relatório da folha também
imprime uma etiqueta `FONTE:`, mas ela repete o mesmo código em todas as páginas e não
corresponde à distribuição real — o sistema a guarda apenas como referência e não a usa.

A Importação 2 em PDF traz ainda o quadro final por fonte:

| | |
|---|---|
| **Folha** | o que será pago naquela fonte |
| **Receita** | o que existe disponível |
| **Saldo** | Receita − Folha |

A versão em planilha não tem esse quadro (traz só a meta, equivalente à coluna Folha).

### O que a consolidação mostra

Para cada um dos 67 grupos: **A pagar** (Importação 2), **Folha** (Importação 1),
**Diferença** e a situação:

| Situação | Significado |
|---|---|
| `confere` | os dois valores batem |
| `não saiu na folha` | tem empenho previsto, a folha não pagou |
| `saiu a menor` / `saiu a maior` | pagou diferente do previsto |
| `fora do empenho` | a folha pagou algo que não estava previsto |
| `sem movimento` | zerado nos dois lados |

### Leitura do relatório da folha (Importação 1)

`lib/parser-folha.js` extrai as três informações que interessam:

1. **o código da natureza** — qualquer coisa no formato `d.d.dd.dd.dd`
   (`3.1.90.11.01`), por padrão e não por lista fixa: códigos novos entram sozinhos;
2. **os valores separados** — a linha `Total Líquido:` traz cinco números, nesta ordem:
   *total, RPPS, RGPS, Militar, Outros*;
3. **o total** — `TOTAL DA FOLHA = (C)`, um por folha, somados por grupo.

Os códigos aparecem na tela num painel próprio, com busca. O mesmo código pode vir com
descrições diferentes ao longo do relatório (`3.1.90.11.01` aparece como "DESPESAS
CORRENTES" e como "VENCIMENTOS E SALARIOS"): eles são somados num único código, ficando
com a descrição do maior valor. A coluna **Cód. empenho** mostra o código de 6 dígitos
equivalente (`3.1.90.11.06` → `319011`), que é como esse mesmo gasto aparece no documento
de empenho.

### Leitura do documento de empenho (Importação 2)

`lib/parser-empenho.js` lê as duas formas do mesmo conteúdo. No PDF, as colunas são
separadas **pelo formato de cada campo**, não pela posição horizontal: ação tem 6
dígitos, valor tem vírgula decimal, plano interno é alfanumérico e fonte tem 10 dígitos.
Cortar por posição perdia a coluna Fonte, porque o rótulo do cabeçalho fica alguns pontos
à direita dos dados.

Um detalhe que rendeu itens fantasmas até ser tratado: o cabeçalho
`160102 – FUNDEB – SEDUC – FOLHA:08/2026` começa com 6 dígitos e um traço, exatamente
como um item, e tem uma barra na competência, exatamente como um grupo — ele é descartado
antes das duas verificações.

### Consolidar para o Empenho

A conferência não é o fim: a Importação 2 vira a **base de trabalho** da tela de empenho.
O botão *Consolidar* apaga a base anterior e reconstrói a partir dela — uma importação,
uma base, as duas telas.

Duas decisões que essa ação toma:

**O teto de cada fonte passa a ser a RECEITA**, não a folha prevista. Com a folha como
teto o saldo daria zero sempre e o controle não controlaria nada. Com a receita, o total
fecha em R$ 395.065.750,47 contra R$ 374.721.680,27 a pagar — a folga real de
R$ 20.344.070,20.

Receita zero é informação, não ausência de dado: a fonte `1540107243` (ETI) paga folha
sem receita própria — o documento mostra saldo negativo nela, coberto pela sobra da
`1540107043`. Ela fica com **teto zero**, e não com o valor da folha: cair para a folha
inventaria um teto que não existe e inflaria o total em R$ 35 milhões.

**Os empenhos já marcados são preservados.** Antes de apagar, o sistema guarda a
combinação `fonte + código + ação + plano interno + grupo` de cada item marcado e devolve
a marcação depois de recarregar. Reconsolidar no meio do mês não faz a operadora refazer o
trabalho.

### Rotas

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/importe/folha` | Importação 1 (multipart `arquivo`) |
| `POST` | `/api/importe/consolidar` | leva a Importação 2 para a base de empenho |
| `POST` | `/api/importe/empenho` | Importação 2 (multipart `arquivo`) |
| `GET` | `/api/importe/consolidado` | a base consolidada: grupos, fontes e totais |
| `GET` | `/api/importe/grupo/:chave` | itens do empenho e total da folha de um grupo |
| `GET` | `/api/importe/naturezas` | naturezas de despesa da Importação 1 |
| `GET` | `/api/importe/export.csv` | consolidação em CSV |
| `DELETE` | `/api/importe/:tipo` | remove `folha` ou `empenho` |

### Tabelas

`importes` (um registro por tipo), `importe_grupos` (o total por grupo — a chave da
junção), `importe_naturezas` (Importação 1), `importe_itens` e `importe_fontes`
(Importação 2).

---

## Operação no dia a dia

1. **Importar planilha** → o sistema cria as fontes e distribui as linhas.
2. Escolher a aba da fonte e informar o **teto orçamentário** → *Salvar teto*.
3. Marcar o *checkbox* **Empenho** de cada item — o saldo, a barra e os totais do
   topo se atualizam na hora.
4. Para grandes volumes: selecionar vários itens pela coluna da esquerda e usar
   **Empenhar selecionados** (a validação de teto considera o conjunto).
5. **Exportar CSV** ao final para anexar ao processo.

Desmarcar o *checkbox* estorna o item e devolve o valor ao saldo.

---

## Deploy na Vercel

### Por que o SQLite não serve lá

A Vercel executa o backend como **função serverless**: cada requisição pode cair em uma
máquina diferente, e o disco é apagado ao fim da execução. Um arquivo `empenho.db` seria
perdido — e, pior, silenciosamente: a tela abriria vazia depois de cada importação.

Por isso o sistema tem dois drivers de banco (`db.js`), com a mesma interface:

| Ambiente | Banco | Como é escolhido |
|---|---|---|
| Local | SQLite em `data/empenho.db` | padrão, sem configuração |
| Vercel | PostgreSQL | quando existe `DATABASE_URL` (ou `POSTGRES_URL`) |

Duas outras coisas mudaram para o modo serverless funcionar:

- **Limite de upload**: a Vercel corta o corpo da requisição em ~4,5 MB. O sistema detecta
  que está lá e recusa antes, com mensagem clara, em vez de deixar o navegador dar erro de
  rede. Localmente o limite continua 25 MB.

### Passo a passo

**1. Crie o banco.** No painel da Vercel: *Storage → Create Database → Postgres* (Neon).
Ao conectar o banco ao projeto, a variável `DATABASE_URL` é injetada automaticamente. Se
usar outro provedor (Neon direto, Supabase, Railway), copie a connection string e cadastre
em *Settings → Environment Variables* com o nome `DATABASE_URL`.

**2. Suba o código.**

```bash
git add . && git commit -m "Sistema de empenho SEDUC"
git push
```

Importe o repositório na Vercel (*Add New → Project*). Não há passo de build: o
`vercel.json` já manda `/api/*` para a função e a Vercel serve `public/` pelo CDN.

**3. Confira.** Abra `https://SEU-PROJETO.vercel.app/api/saude`. A resposta deve dizer
`"banco":"postgres"`. As tabelas são criadas sozinhas na primeira requisição.

**4. Importe a planilha** pela tela, normalmente.

### Levar os dados locais junto

Só vale a pena se já houver empenhos marcados no banco local — senão é mais rápido
importar a planilha de novo. Com o banco de produção ainda vazio:

```bash
DATABASE_URL="postgres://..." npm run migrar
```

O script copia fontes, arquivos, linhas e movimentos preservando os ids, e realinha as
sequências. Ele se recusa a rodar se o destino já tiver fontes, para não duplicar dados.

### Alternativa: manter o SQLite

Se a Vercel não for uma exigência, plataformas com disco persistente (Render, Railway,
Fly.io) rodam este sistema **sem alteração nenhuma**: basta apontar para um volume e usar
`SEDUC_DB` para o caminho do arquivo. Para uma ferramenta interna com uma operadora, é a
opção mais simples de manter — um backup é copiar um arquivo.

---

## Notas de implantação

- Localmente o banco fica em `data/empenho.db` (SQLite, modo WAL). Backup = copiar esse
  arquivo. Para começar do zero, pare o servidor e apague `data/empenho.db*`. Em produção
  o banco é PostgreSQL — veja a seção de deploy.
- Não há autenticação: o sistema pressupõe uso em rede interna. O campo
  `empenhado_por` já existe para receber o usuário quando houver login (hoje grava
  `operador`).
- Limite de upload: 25 MB (ajustável em `server.js`, opção `limits.fileSize`).
- Listagem limitada a 5.000 linhas por fonte na tela; acima disso, use os filtros.
