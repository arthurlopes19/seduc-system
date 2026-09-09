'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');

const { db, pronto, agora, DRIVER } = require('./db');
const { processarPlanilha } = require('./lib/parser');
const { processarPlanilhaPorFonte, ehPlanilhaPorFonte, COLUNAS } = require('./lib/parser-padrao');
const { normalizarTexto, paraCentavos, formatarBRL } = require('./lib/util');
const importe = require('./lib/importe');

const app = express();
const PORT = process.env.PORT || 3000;

/*
 * Em serverless (Vercel) o corpo da requisição é limitado a ~4,5 MB pela
 * plataforma. Anunciar um limite maior só produziria erro de rede sem
 * mensagem; melhor recusar antes, com texto claro.
 */
const NA_VERCEL = Boolean(process.env.VERCEL);
const LIMITE_UPLOAD = NA_VERCEL ? 4 * 1024 * 1024 : 25 * 1024 * 1024;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cada requisição garante que o esquema existe (uma vez por processo).
app.use(async (_req, _res, next) => {
  try {
    await pronto();
    next();
  } catch (e) {
    next(e);
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITE_UPLOAD },
});

/** Envolve um handler async para que erros caiam no tratador do Express. */
const rota = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ *
 * Fontes
 * ------------------------------------------------------------------ */

/** Cria a fonte se ainda nao existir e devolve o id (formato plano). */
async function garantirFonte(nome, tx = db) {
  const norm = normalizarTexto(nome);
  const existente = await tx.um('SELECT id FROM fontes WHERE nome_normalizado = ?', [norm]);
  if (existente) return existente.id;

  const r = await tx.executar(
    'INSERT INTO fontes (nome, nome_normalizado, criado_em) VALUES (?, ?, ?) RETURNING id',
    [String(nome).trim(), norm, agora()]
  );
  return r.id;
}

/**
 * Fonte da planilha padrao: a identidade e o CODIGO (1540107043), nao o titulo.
 * O titulo pode mudar de uma competencia para outra sem virar outra fonte.
 * A meta da planilha vira o teto orcamentario.
 */
async function garantirFonteOrcamento({ codigo, titulo, metaCentavos }, tx = db) {
  const norm = normalizarTexto(codigo);
  const meta = metaCentavos || 0;

  const existente = await tx.um(
    'SELECT id FROM fontes WHERE codigo = ? OR nome_normalizado = ?', [codigo, norm]
  );

  if (existente) {
    await tx.executar(
      `UPDATE fontes
         SET nome = ?, codigo = ?, titulo = ?, meta_centavos = ?, teto_centavos = ?, atualizado_em = ?
       WHERE id = ?`,
      [titulo, codigo, titulo, meta, meta, agora(), existente.id]
    );
    return existente.id;
  }

  const r = await tx.executar(
    `INSERT INTO fontes (nome, nome_normalizado, codigo, titulo, meta_centavos, teto_centavos, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [titulo, norm, codigo, titulo, meta, meta, agora()]
  );
  return r.id;
}

const SQL_RESUMO_FONTES = `
  SELECT
    f.id,
    f.nome,
    f.codigo,
    f.titulo,
    f.meta_centavos                                               AS "metaCentavos",
    f.teto_centavos                                               AS "tetoCentavos",
    COALESCE(COUNT(l.id), 0)                                      AS "totalItens",
    COALESCE(SUM(l.valor_centavos), 0)                            AS "totalCentavos",
    COALESCE(SUM(CASE WHEN l.empenhado = 1 THEN 1 ELSE 0 END), 0) AS "itensEmpenhados",
    COALESCE(SUM(CASE WHEN l.empenhado = 1 THEN l.valor_centavos ELSE 0 END), 0)
                                                                  AS "empenhadoCentavos"
  FROM fontes f
  LEFT JOIN linhas l ON l.fonte_id = f.id
  GROUP BY f.id, f.nome, f.codigo, f.titulo, f.meta_centavos, f.teto_centavos
  ORDER BY f.nome
`;

async function listarFontes() {
  const fontes = await db.consulta(SQL_RESUMO_FONTES);
  return fontes.map((f) => ({
    ...f,
    totalItens: Number(f.totalItens),
    totalCentavos: Number(f.totalCentavos),
    itensEmpenhados: Number(f.itensEmpenhados),
    empenhadoCentavos: Number(f.empenhadoCentavos),
    pendenteCentavos: Number(f.totalCentavos) - Number(f.empenhadoCentavos),
    saldoCentavos: Number(f.tetoCentavos) - Number(f.empenhadoCentavos),
    estourouTeto: Number(f.tetoCentavos) > 0 && Number(f.empenhadoCentavos) > Number(f.tetoCentavos),
  }));
}

async function obterFonte(id) {
  const fontes = await listarFontes();
  return fontes.find((f) => Number(f.id) === Number(id)) || null;
}

/** Total ja empenhado na fonte (em centavos). */
async function empenhadoDaFonte(fonteId) {
  const r = await db.um(
    'SELECT COALESCE(SUM(valor_centavos), 0) AS t FROM linhas WHERE fonte_id = ? AND empenhado = 1',
    [fonteId]
  );
  return Number(r.t);
}

async function registrarMovimento(tx, linhaId, acao, valorCentavos, usuario) {
  await tx.executar(
    'INSERT INTO movimentos (linha_id, acao, valor_centavos, usuario, criado_em) VALUES (?, ?, ?, ?, ?)',
    [linhaId, acao, valorCentavos, usuario || null, agora()]
  );
}

/* ------------------------------------------------------------------ *
 * Busca e montagem de linhas
 * ------------------------------------------------------------------ */

const SELECT_LINHA = `
  SELECT id,
         arquivo_id      AS "arquivoId",
         fonte_id        AS "fonteId",
         linha_planilha  AS "linhaPlanilha",
         matricula, nome, cargo, lotacao, descricao, competencia,
         grupo, codigo, acao,
         plano_interno   AS "planoInterno",
         valor_centavos  AS "valorCentavos",
         empenhado,
         empenhado_em    AS "empenhadoEm",
         dados_extra     AS "dadosExtra"
  FROM linhas
`;

/** Campos que compoem o texto pesquisavel de uma linha. */
const CAMPOS_TEXTO = [
  'matricula', 'nome', 'cargo', 'lotacao', 'descricao', 'competencia',
  'grupo', 'codigo', 'acao', 'plano_interno',
];

/** Junta os campos em um unico texto sem acento e em caixa alta. */
function textoDeBusca(valores) {
  return normalizarTexto(valores.filter((v) => v !== null && v !== undefined && v !== '').join(' '));
}

/**
 * Linhas gravadas antes da coluna `busca_texto` existir ficam sem indice de
 * busca. Preenche uma vez, na subida do servidor.
 */
async function preencherBuscaPendente() {
  const pendentes = await db.consulta(
    `SELECT id, ${CAMPOS_TEXTO.join(', ')} FROM linhas WHERE busca_texto IS NULL LIMIT 50000`
  );
  if (!pendentes.length) return;

  await db.emTransacao(async (tx) => {
    for (const l of pendentes) {
      await tx.executar('UPDATE linhas SET busca_texto = ? WHERE id = ?',
        [textoDeBusca(CAMPOS_TEXTO.map((c) => l[c])), l.id]);
    }
  });
  console.log(`Índice de busca preenchido para ${pendentes.length} linha(s).`);
}

/**
 * Monta o filtro da barra de busca.
 *
 * Texto: compara com `busca_texto`, que guarda os campos sem acento e em
 * caixa alta — o UPPER() do SQLite só entende ASCII, então "Auxílio" nunca
 * casaria com "AUXÍLIO".
 *
 * Valor: "1.500,00", "1500,00" e "1500" acham R$ 1.500,00. São duas
 * comparações — igualdade exata em centavos e "contém" sobre os dígitos dos
 * centavos — para achar o valor cheio ou um pedaço dele.
 *
 * As condições de valor só entram quando o termo tem algum dígito; sem isso
 * uma busca por texto puro cairia em `valor_centavos = 0` e traria todos os
 * itens sem valor alocado.
 */
function filtroDeBusca(busca) {
  const termo = String(busca).trim();

  const partes = [`COALESCE(busca_texto, '') LIKE ?`];
  const valores = [`%${normalizarTexto(termo)}%`];

  if (/\d/.test(termo)) {
    partes.push('valor_centavos = ?');
    valores.push(paraCentavos(termo));

    // Só os dígitos: "1.500,00" -> "150000" (centavos de R$ 1.500,00).
    const digitos = termo.replace(/\D/g, '');
    if (digitos) {
      partes.push('CAST(valor_centavos AS TEXT) LIKE ?');
      valores.push(`%${digitos}%`);
    }
  }

  return { sql: `(${partes.join(' OR ')})`, valores };
}

/**
 * Uma fonte e "orcamentaria" quando suas linhas vem da planilha padrao
 * (tem Grupo / Plano Interno / Codigo). Define o conjunto de colunas da tela.
 */
async function formatoDaFonte(fonteId) {
  const r = await db.um(
    `SELECT COUNT(*) AS n FROM linhas
      WHERE fonte_id = ? AND (grupo IS NOT NULL OR plano_interno IS NOT NULL OR codigo IS NOT NULL)`,
    [fonteId]
  );
  return Number(r.n) > 0 ? 'orcamento' : 'folha';
}

/** Linha crua do banco -> objeto na ordem de colunas do negocio. */
function montarLinha(l, fonte) {
  return {
    id: l.id,
    arquivoId: l.arquivoId,
    fonteId: l.fonteId,
    linhaPlanilha: l.linhaPlanilha,
    // Colunas da planilha padrao, na ordem exigida (Fonte por ultimo).
    grupo: l.grupo || '',
    codigo: l.codigo || '',
    acaoDespesa: l.descricao || '',
    acao: l.acao || '',
    valorCentavos: Number(l.valorCentavos),
    planoInterno: l.planoInterno || '',
    fonte: fonte?.codigo || fonte?.nome || '',
    // Colunas do formato de folha (planilha plana).
    matricula: l.matricula || '',
    nome: l.nome || '',
    cargo: l.cargo || '',
    lotacao: l.lotacao || '',
    descricao: l.descricao || '',
    competencia: l.competencia || '',
    empenhado: Number(l.empenhado) === 1,
    empenhadoEm: l.empenhadoEm,
    dadosExtra: l.dadosExtra,
  };
}

/* ------------------------------------------------------------------ *
 * Importacao
 * ------------------------------------------------------------------ */

/** Aceita o mapeamento manual vindo como objeto (JSON) ou string (multipart). */
function lerMapeamento(valor) {
  if (!valor) return null;
  try {
    const m = typeof valor === 'string' ? JSON.parse(valor) : valor;
    if (!m || typeof m !== 'object' || !m.mapa) return null;
    const mapa = {};
    for (const [campo, idx] of Object.entries(m.mapa)) {
      const n = Number(idx);
      if (Number.isInteger(n) && n >= 0) mapa[campo] = n;
    }
    return { indiceLinha: Number(m.indiceLinha) || 0, mapa };
  } catch {
    return null;
  }
}

function responderErroDeImportacao(res, e) {
  const corpo = { erro: e.message };
  if (e.codigo) corpo.codigo = e.codigo;
  if (e.amostra) corpo.amostra = e.amostra;
  if (e.totalLinhas) corpo.totalLinhas = e.totalLinhas;
  res.status(e.status || 500).json(corpo);
}

/**
 * Importa a planilha padrao: uma aba por fonte, titulo na primeira linha,
 * colunas Grupo / Codigo / Acao-Despesa / Acao / Valor / Plano Interno / Fonte.
 */
async function importarPorFonte(buffer, nomeOriginal) {
  const dados = processarPlanilhaPorFonte(buffer);

  const resultado = await db.emTransacao(async (tx) => {
    const totalLinhas = dados.fontes.reduce((s, f) => s + f.quantidade, 0);

    const arq = await tx.executar(
      `INSERT INTO arquivos (nome_original, competencia, total_linhas, valor_total_centavos, enviado_em)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [nomeOriginal, dados.competencia, totalLinhas, dados.totalCentavos, agora()]
    );
    const arquivoId = arq.id;

    const SQL_INSERIR = `
      INSERT INTO linhas
        (arquivo_id, fonte_id, linha_planilha, descricao, competencia,
         grupo, codigo, acao, plano_interno, valor_centavos, busca_texto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const detalhe = [];
    for (const f of dados.fontes) {
      const fonteId = await garantirFonteOrcamento(f, tx);
      for (const it of f.itens) {
        await tx.executar(SQL_INSERIR, [
          arquivoId, fonteId, it.linhaPlanilha, it.acaoDespesa || null, f.competencia || null,
          it.grupo || null, it.codigo || null, it.acao || null, it.planoInterno || null,
          it.valorCentavos,
          textoDeBusca([it.grupo, it.codigo, it.acaoDespesa, it.acao, it.planoInterno, f.codigo]),
        ]);
      }
      detalhe.push({
        fonteId,
        codigo: f.codigo,
        titulo: f.titulo,
        aba: f.aba,
        quantidade: f.quantidade,
        itensSemValor: f.itensSemValor,
        somaCentavos: f.somaItensCentavos,
        metaCentavos: f.metaCentavos,
        status: f.status,
      });
    }

    return { arquivoId, totalLinhas, detalhe };
  });

  return {
    ok: true,
    formato: 'orcamento',
    arquivoId: resultado.arquivoId,
    linhasImportadas: resultado.totalLinhas,
    linhasIgnoradas: 0,
    linhasNaoIdentificadas: 0,
    fontesEncontradas: dados.fontes.length,
    valorTotalCentavos: dados.totalCentavos,
    metaTotalCentavos: dados.metaTotalCentavos,
    competencia: dados.competencia,
    colunas: COLUNAS,
    fontes: resultado.detalhe,
    avisos: dados.avisos,
  };
}

/** Importa a planilha plana (uma aba, coluna "Fonte" em cada linha). */
async function importarPlano(buffer, nomeOriginal, mapeamento) {
  let processado;
  try {
    processado = processarPlanilha(buffer, nomeOriginal, mapeamento);
  } catch (e) {
    // `codigo` e `amostra` alimentam a tela de mapeamento manual.
    throw Object.assign(new Error(e.message), {
      status: 422,
      codigo: e.codigo,
      amostra: e.amostra,
      totalLinhas: e.totalLinhas,
    });
  }

  const { registros, ignoradas, naoIdentificadas, avisos, mapa, cabecalhos } = processado;

  const resultado = await db.emTransacao(async (tx) => {
    const totalCentavos = registros.reduce((s, r) => s + r.valorCentavos, 0);
    const competencia = registros.find((r) => r.competencia)?.competencia || null;

    const arq = await tx.executar(
      `INSERT INTO arquivos (nome_original, competencia, total_linhas, valor_total_centavos, enviado_em)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [nomeOriginal, competencia, registros.length, totalCentavos, agora()]
    );
    const arquivoId = arq.id;

    const SQL_INSERIR = `
      INSERT INTO linhas
        (arquivo_id, fonte_id, linha_planilha, matricula, nome, cargo, lotacao,
         descricao, competencia, valor_centavos, dados_extra, busca_texto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const cacheFontes = new Map();
    const fontesTocadas = new Set();

    for (const r of registros) {
      const chave = normalizarTexto(r.fonte);
      let fonteId = cacheFontes.get(chave);
      if (fonteId === undefined) {
        fonteId = await garantirFonte(r.fonte, tx);
        cacheFontes.set(chave, fonteId);
      }
      fontesTocadas.add(fonteId);

      await tx.executar(SQL_INSERIR, [
        arquivoId, fonteId, r.linhaPlanilha, r.matricula || null, r.nome || null,
        r.cargo || null, r.lotacao || null, r.descricao || null, r.competencia || null,
        r.valorCentavos, r.dadosExtra,
        textoDeBusca([r.matricula, r.nome, r.cargo, r.lotacao, r.descricao, r.competencia, r.fonte]),
      ]);
    }

    return { arquivoId, totalCentavos, fontes: fontesTocadas.size };
  });

  return {
    ok: true,
    formato: 'folha',
    arquivoId: resultado.arquivoId,
    linhasImportadas: registros.length,
    linhasIgnoradas: ignoradas,
    linhasNaoIdentificadas: naoIdentificadas,
    fontesEncontradas: resultado.fontes,
    valorTotalCentavos: resultado.totalCentavos,
    colunasReconhecidas: Object.fromEntries(
      Object.entries(mapa).map(([campo, idx]) => [campo, cabecalhos[idx] || `col ${idx + 1}`])
    ),
    avisos,
  };
}

async function importarPlanilha(buffer, nomeOriginal, mapeamento = null) {
  // A planilha padrao (uma aba por fonte) tem caminho proprio. O mapeamento
  // manual so existe para o formato plano, entao ele desliga a deteccao.
  if (!mapeamento && /\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(nomeOriginal)) {
    let wb = null;
    try {
      wb = XLSX.read(buffer, { type: 'buffer' });
    } catch { /* nao e planilha legivel: segue pelo caminho plano */ }
    if (wb && ehPlanilhaPorFonte(wb)) return importarPorFonte(buffer, nomeOriginal);
  }
  return importarPlano(buffer, nomeOriginal, mapeamento);
}

/* ------------------------------------------------------------------ *
 * Rotas — arquivos
 * ------------------------------------------------------------------ */

app.post('/api/arquivos', upload.single('arquivo'), rota(async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

  if (/\.pdf$/i.test(req.file.originalname)) {
    return res.status(422).json({
      erro: 'PDF não pode ser importado direto no empenho. Use a aba '
        + '"Conversor para Excel" e depois clique em "Importar para o empenho".',
    });
  }

  try {
    res.json(await importarPlanilha(
      req.file.buffer, req.file.originalname, lerMapeamento(req.body?.mapeamento)
    ));
  } catch (e) {
    responderErroDeImportacao(res, e);
  }
}));

app.get('/api/arquivos', rota(async (_req, res) => {
  const linhas = await db.consulta(`
    SELECT a.id,
           a.nome_original        AS "nomeOriginal",
           a.competencia,
           a.total_linhas         AS "totalLinhas",
           a.valor_total_centavos AS "valorTotalCentavos",
           a.enviado_em           AS "enviadoEm",
           COALESCE(SUM(CASE WHEN l.empenhado = 1 THEN 1 ELSE 0 END), 0) AS "itensEmpenhados"
    FROM arquivos a
    LEFT JOIN linhas l ON l.arquivo_id = a.id
    GROUP BY a.id, a.nome_original, a.competencia, a.total_linhas,
             a.valor_total_centavos, a.enviado_em
    ORDER BY a.id DESC
  `);
  res.json(linhas.map((a) => ({
    ...a,
    totalLinhas: Number(a.totalLinhas),
    valorTotalCentavos: Number(a.valorTotalCentavos),
    itensEmpenhados: Number(a.itensEmpenhados),
  })));
}));

app.delete('/api/arquivos/:id', rota(async (req, res) => {
  const id = Number(req.params.id);
  const arq = await db.um('SELECT id FROM arquivos WHERE id = ?', [id]);
  if (!arq) return res.status(404).json({ erro: 'Arquivo nao encontrado.' });

  await db.emTransacao(async (tx) => {
    await tx.executar('DELETE FROM linhas WHERE arquivo_id = ?', [id]);
    await tx.executar('DELETE FROM arquivos WHERE id = ?', [id]);
  });

  res.json({ ok: true, fontes: await listarFontes() });
}));

/* ------------------------------------------------------------------ *
 * Rotas — fontes e teto
 * ------------------------------------------------------------------ */

app.get('/api/fontes', rota(async (_req, res) => res.json(await listarFontes())));

app.put('/api/fontes/:id/teto', rota(async (req, res) => {
  const id = Number(req.params.id);
  const fonte = await db.um('SELECT id FROM fontes WHERE id = ?', [id]);
  if (!fonte) return res.status(404).json({ erro: 'Fonte nao encontrada.' });

  const teto = req.body?.tetoCentavos !== undefined
    ? Math.round(Number(req.body.tetoCentavos))
    : paraCentavos(req.body?.teto);

  if (!Number.isFinite(teto) || teto < 0) {
    return res.status(400).json({ erro: 'Teto invalido.' });
  }

  await db.executar('UPDATE fontes SET teto_centavos = ?, atualizado_em = ? WHERE id = ?',
    [teto, agora(), id]);

  res.json({ ok: true, fonte: await obterFonte(id) });
}));

app.delete('/api/fontes/:id', rota(async (req, res) => {
  const id = Number(req.params.id);
  const qtd = await db.um('SELECT COUNT(*) AS n FROM linhas WHERE fonte_id = ?', [id]);
  if (Number(qtd.n) > 0) {
    return res.status(409).json({ erro: 'A fonte ainda possui linhas importadas.' });
  }
  await db.executar('DELETE FROM fontes WHERE id = ?', [id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Rotas — linhas e empenho
 * ------------------------------------------------------------------ */

app.get('/api/fontes/:id/linhas', rota(async (req, res) => {
  const id = Number(req.params.id);
  const { status, busca, arquivoId } = req.query;

  const cond = ['fonte_id = ?'];
  const args = [id];

  if (status === 'empenhados') cond.push('empenhado = 1');
  if (status === 'pendentes') cond.push('empenhado = 0');
  if (arquivoId) { cond.push('arquivo_id = ?'); args.push(Number(arquivoId)); }
  if (busca) {
    const { sql, valores } = filtroDeBusca(busca);
    cond.push(sql);
    args.push(...valores);
  }

  const [fonte, formato] = await Promise.all([obterFonte(id), formatoDaFonte(id)]);
  const brutas = await db.consulta(
    `${SELECT_LINHA} WHERE ${cond.join(' AND ')} ORDER BY empenhado, id LIMIT 5000`, args
  );

  res.json({
    fonte,
    formato,
    colunas: formato === 'orcamento' ? COLUNAS : null,
    linhas: brutas.map((l) => montarLinha(l, fonte)),
  });
}));

/**
 * Empenha ou estorna um conjunto de linhas.
 * Body: { ids: number[], empenhado: boolean, forcar?: boolean, usuario?: string }
 * O teto e validado no servidor: se a operacao estourar o limite, a resposta
 * e 409 com o detalhamento (a menos que `forcar` seja true).
 */
app.post('/api/empenhos', rota(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const empenhar = req.body?.empenhado !== false;
  const forcar = req.body?.forcar === true;
  const usuario = req.body?.usuario || 'operador';

  if (!ids.length) return res.status(400).json({ erro: 'Nenhum item informado.' });

  const marcadores = ids.map(() => '?').join(',');
  const alvo = await db.consulta(
    `SELECT id, fonte_id AS "fonteId", valor_centavos AS "valorCentavos", empenhado
       FROM linhas WHERE id IN (${marcadores})`, ids
  );

  if (!alvo.length) return res.status(404).json({ erro: 'Itens nao encontrados.' });

  const fonteId = Number(alvo[0].fonteId);
  if (alvo.some((l) => Number(l.fonteId) !== fonteId)) {
    return res.status(400).json({ erro: 'Todos os itens devem pertencer a mesma fonte.' });
  }

  // Somente as linhas que realmente mudam de estado entram na conta.
  const mudam = alvo.filter((l) => (Number(l.empenhado) === 1) !== empenhar);
  if (!mudam.length) {
    return res.json({ ok: true, alterados: 0, fonte: await obterFonte(fonteId) });
  }

  const delta = mudam.reduce((s, l) => s + Number(l.valorCentavos), 0);
  const fonte = await obterFonte(fonteId);

  if (empenhar && fonte.tetoCentavos > 0 && !forcar) {
    const novoTotal = (await empenhadoDaFonte(fonteId)) + delta;
    if (novoTotal > fonte.tetoCentavos) {
      return res.status(409).json({
        erro: 'TETO_EXCEDIDO',
        mensagem: `Esta acao ultrapassa o teto da fonte "${fonte.nome}".`,
        fonte,
        necessarioCentavos: delta,
        saldoCentavos: fonte.saldoCentavos,
        excedenteCentavos: novoTotal - fonte.tetoCentavos,
      });
    }
  }

  await db.emTransacao(async (tx) => {
    const flag = empenhar ? 1 : 0;
    const quando = empenhar ? agora() : null;
    for (const l of mudam) {
      await tx.executar(
        'UPDATE linhas SET empenhado = ?, empenhado_em = ?, empenhado_por = ? WHERE id = ?',
        [flag, quando, empenhar ? usuario : null, l.id]
      );
      await registrarMovimento(tx, l.id, empenhar ? 'EMPENHO' : 'ESTORNO',
        Number(l.valorCentavos), usuario);
    }
  });

  const atualizada = await obterFonte(fonteId);
  const linhas = await db.consulta(`${SELECT_LINHA} WHERE id IN (${marcadores})`, ids);

  res.json({
    ok: true,
    alterados: mudam.length,
    deltaCentavos: empenhar ? delta : -delta,
    forcado: forcar && empenhar,
    fonte: atualizada,
    linhas: linhas.map((l) => montarLinha(l, atualizada)),
  });
}));

/* ------------------------------------------------------------------ *
 * Aba "Importe" — as duas importações e a consolidação
 * ------------------------------------------------------------------ */

/** Importação 1: relatório da folha (PDF). */
app.post('/api/importe/folha', upload.single('arquivo'), rota(async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
  try {
    res.json(await importe.importarFolha(req.file.buffer, req.file.originalname));
  } catch (e) {
    res.status(422).json({ erro: e.message });
  }
}));

/** Importação 2: documento de empenho (PDF ou planilha). */
app.post('/api/importe/empenho', upload.single('arquivo'), rota(async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
  try {
    res.json(await importe.importarEmpenho(req.file.buffer, req.file.originalname));
  } catch (e) {
    res.status(422).json({ erro: e.message });
  }
}));

/** A base consolidada: os 67 grupos com os dois lados e a diferença. */
app.get('/api/importe/consolidado', rota(async (_req, res) => {
  res.json(await importe.consolidar());
}));

/** Detalhe de um grupo: itens do empenho + total da folha. */
app.get('/api/importe/grupo/:chave', rota(async (req, res) => {
  res.json(await importe.detalharGrupo(req.params.chave));
}));

/** Naturezas de despesa da Importação 1. */
app.get('/api/importe/naturezas', rota(async (_req, res) => {
  res.json(await importe.listarNaturezas());
}));

app.delete('/api/importe/:tipo', rota(async (req, res) => {
  const tipo = req.params.tipo;
  if (tipo !== importe.TIPOS.FOLHA && tipo !== importe.TIPOS.EMPENHO) {
    return res.status(400).json({ erro: 'Tipo inválido.' });
  }
  res.json({ ok: await importe.limpar(tipo) });
}));

/**
 * Consolida: transforma a Importação 2 na base de trabalho da aba Empenho.
 * Body opcional: { tetoPor: 'receita' | 'folha' }.
 */
app.post('/api/importe/consolidar', rota(async (req, res) => {
  try {
    res.json(await importe.consolidarParaEmpenho({ tetoPor: req.body?.tetoPor }));
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
}));

/** Exporta a consolidação em CSV. */
app.get('/api/importe/export.csv', rota(async (_req, res) => {
  const dados = await importe.consolidar();
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [
    ['Grupo', 'Empenho (a pagar)', 'Folha (pago)', 'Diferenca', 'Situacao'].join(';'),
    ...dados.grupos.map((g) => [
      g.grupo, formatarBRL(g.empenhoCentavos), formatarBRL(g.folhaCentavos),
      formatarBRL(g.diferencaCentavos), g.situacao,
    ].map(escapar).join(';')),
    ['TOTAL', formatarBRL(dados.totais.empenhoCentavos), formatarBRL(dados.totais.folhaCentavos),
     formatarBRL(dados.totais.diferencaCentavos), ''].map(escapar).join(';'),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="consolidado.csv"');
  res.send('﻿' + linhas.join('\r\n'));
}));

/* ------------------------------------------------------------------ *
 * Resumo geral e exportacao
 * ------------------------------------------------------------------ */

app.get('/api/resumo', rota(async (_req, res) => {
  const fontes = await listarFontes();
  const soma = (campo) => fontes.reduce((s, f) => s + Number(f[campo]), 0);
  res.json({
    fontes: fontes.length,
    tetoCentavos: soma('tetoCentavos'),
    totalCentavos: soma('totalCentavos'),
    empenhadoCentavos: soma('empenhadoCentavos'),
    pendenteCentavos: soma('pendenteCentavos'),
    saldoCentavos: soma('saldoCentavos'),
    itens: soma('totalItens'),
    itensEmpenhados: soma('itensEmpenhados'),
  });
}));

app.get('/api/fontes/:id/export.csv', rota(async (req, res) => {
  const id = Number(req.params.id);
  const fonte = await obterFonte(id);
  if (!fonte) return res.status(404).json({ erro: 'Fonte nao encontrada.' });

  const brutas = await db.consulta(`${SELECT_LINHA} WHERE fonte_id = ? ORDER BY id`, [id]);
  const linhas = brutas.map((l) => montarLinha(l, fonte));
  const orcamento = (await formatoDaFonte(id)) === 'orcamento';

  // A ordem das colunas do CSV acompanha a da tela.
  const cabecalho = orcamento
    ? ['Grupo', 'Codigo', 'Acao/Despesa', 'Acao', 'Valor', 'Plano Interno', 'Fonte',
       'Status', 'Empenhado em']
    : ['Matricula', 'Nome', 'Cargo', 'Lotacao', 'Descricao', 'Competencia',
       'Valor', 'Status', 'Empenhado em'];

  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const corpo = linhas.map((l) => (orcamento
    ? [l.grupo, l.codigo, l.acaoDespesa, l.acao, formatarBRL(l.valorCentavos),
       l.planoInterno, l.fonte]
    : [l.matricula, l.nome, l.cargo, l.lotacao, l.descricao, l.competencia,
       formatarBRL(l.valorCentavos)]
  ).concat([
    l.empenhado ? 'EMPENHADO' : 'PENDENTE',
    l.empenhadoEm || '',
  ]).map(escapar).join(';'));

  const csv = '﻿' + [cabecalho.join(';'), ...corpo].join('\r\n');
  const nome = String(fonte.codigo || fonte.nome).replace(/[^\w\-]+/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="empenho_${nome}.csv"`);
  res.send(csv);
}));

/** Diagnóstico: qual banco está em uso. Útil depois do deploy. */
app.get('/api/saude', rota(async (_req, res) => {
  const r = await db.um('SELECT COUNT(*) AS n FROM fontes');
  res.json({ ok: true, banco: DRIVER, fontes: Number(r.n), vercel: NA_VERCEL });
}));

/* ------------------------------------------------------------------ */

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const limiteMb = Math.round(LIMITE_UPLOAD / 1024 / 1024);
    const detalhe = err.code === 'LIMIT_FILE_SIZE'
      ? `Arquivo maior que o limite de ${limiteMb} MB`
        + (NA_VERCEL ? ' (teto da plataforma para funções serverless).' : '.')
      : err.message;
    return res.status(400).json({ erro: `Falha no upload: ${detalhe}` });
  }
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// Na Vercel o arquivo é importado como função: quem escuta é a plataforma.
if (require.main === module) {
  (async () => {
    await pronto();
    await preencherBuscaPendente();
    app.listen(PORT, () => {
      console.log(`Sistema de Empenho SEDUC rodando em http://localhost:${PORT} (banco: ${DRIVER})`);
    });
  })().catch((e) => {
    console.error('Falha ao iniciar:', e);
    process.exit(1);
  });
}

module.exports = app;
