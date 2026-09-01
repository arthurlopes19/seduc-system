'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');

const { db } = require('./db');
const { processarPlanilha } = require('./lib/parser');
const { processarPlanilhaPorFonte, ehPlanilhaPorFonte, COLUNAS } = require('./lib/parser-padrao');
const { converterParaXlsx } = require('./lib/conversor');
const { normalizarTexto, paraCentavos, formatarBRL } = require('./lib/util');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/* ------------------------------------------------------------------ *
 * Helpers de acesso a dados
 * ------------------------------------------------------------------ */

function emTransacao(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Cria a fonte se ainda nao existir e devolve o id. */
function garantirFonte(nome) {
  const norm = normalizarTexto(nome);
  const existente = db.prepare('SELECT id FROM fontes WHERE nome_normalizado = ?').get(norm);
  if (existente) return existente.id;
  const r = db
    .prepare('INSERT INTO fontes (nome, nome_normalizado) VALUES (?, ?)')
    .run(String(nome).trim(), norm);
  return Number(r.lastInsertRowid);
}

/**
 * Fonte da planilha padrao: identidade e o CODIGO (1540107043), nao o titulo.
 * O titulo pode mudar de uma competencia para outra sem virar outra fonte.
 * A meta da planilha vira o teto orcamentario da fonte.
 */
function garantirFonteOrcamento({ codigo, titulo, metaCentavos }) {
  const norm = normalizarTexto(codigo);
  const existente = db.prepare('SELECT id FROM fontes WHERE codigo = ? OR nome_normalizado = ?')
    .get(codigo, norm);

  if (existente) {
    db.prepare(`UPDATE fontes
                SET nome = ?, codigo = ?, titulo = ?, meta_centavos = ?, teto_centavos = ?,
                    atualizado_em = datetime('now','localtime')
                WHERE id = ?`)
      .run(titulo, codigo, titulo, metaCentavos || 0, metaCentavos || 0, existente.id);
    return existente.id;
  }

  const r = db.prepare(`INSERT INTO fontes
      (nome, nome_normalizado, codigo, titulo, meta_centavos, teto_centavos)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(titulo, norm, codigo, titulo, metaCentavos || 0, metaCentavos || 0);
  return Number(r.lastInsertRowid);
}

const SQL_RESUMO_FONTES = `
  SELECT
    f.id,
    f.nome,
    f.codigo,
    f.titulo,
    f.meta_centavos                                                  AS metaCentavos,
    f.teto_centavos                                                  AS tetoCentavos,
    COALESCE(COUNT(l.id), 0)                                         AS totalItens,
    COALESCE(SUM(l.valor_centavos), 0)                               AS totalCentavos,
    COALESCE(SUM(CASE WHEN l.empenhado = 1 THEN 1 ELSE 0 END), 0)    AS itensEmpenhados,
    COALESCE(SUM(CASE WHEN l.empenhado = 1 THEN l.valor_centavos ELSE 0 END), 0)
                                                                     AS empenhadoCentavos
  FROM fontes f
  LEFT JOIN linhas l ON l.fonte_id = f.id
  GROUP BY f.id
  ORDER BY f.nome
`;

function listarFontes() {
  return db.prepare(SQL_RESUMO_FONTES).all().map((f) => ({
    ...f,
    pendenteCentavos: f.totalCentavos - f.empenhadoCentavos,
    saldoCentavos: f.tetoCentavos - f.empenhadoCentavos,
    estourouTeto: f.tetoCentavos > 0 && f.empenhadoCentavos > f.tetoCentavos,
  }));
}

function obterFonte(id) {
  return listarFontes().find((f) => f.id === Number(id)) || null;
}

/** Total ja empenhado na fonte (em centavos). */
function empenhadoDaFonte(fonteId) {
  const r = db
    .prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS t FROM linhas WHERE fonte_id = ? AND empenhado = 1')
    .get(fonteId);
  return r.t;
}

function registrarMovimento(linhaId, acao, valorCentavos, usuario) {
  db.prepare('INSERT INTO movimentos (linha_id, acao, valor_centavos, usuario) VALUES (?, ?, ?, ?)')
    .run(linhaId, acao, valorCentavos, usuario || null);
}

/* ------------------------------------------------------------------ *
 * Upload / arquivos
 * ------------------------------------------------------------------ */

/** Aceita o mapeamento manual vindo como objeto (JSON) ou como string (multipart). */
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
 * Importa um buffer de planilha para o banco.
 * Usado tanto pelo upload direto quanto pelo conversor.
 * Lanca Error com `.status` quando a planilha nao pode ser lida.
 */
/**
 * Importa a planilha padrao: uma aba por fonte, titulo na primeira linha,
 * colunas Grupo / Codigo / Acao-Despesa / Acao / Valor / Plano Interno / Fonte.
 */
function importarPorFonte(buffer, nomeOriginal) {
  const dados = processarPlanilhaPorFonte(buffer);

  const resultado = emTransacao(() => {
    const totalLinhas = dados.fontes.reduce((s, f) => s + f.quantidade, 0);

    const arq = db
      .prepare(`INSERT INTO arquivos (nome_original, competencia, total_linhas, valor_total_centavos)
                VALUES (?, ?, ?, ?)`)
      .run(nomeOriginal, dados.competencia, totalLinhas, dados.totalCentavos);
    const arquivoId = Number(arq.lastInsertRowid);

    const inserir = db.prepare(`
      INSERT INTO linhas
        (arquivo_id, fonte_id, linha_planilha, descricao, competencia,
         grupo, codigo, acao, plano_interno, valor_centavos, busca_texto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const detalhe = [];
    for (const f of dados.fontes) {
      const fonteId = garantirFonteOrcamento(f);
      for (const it of f.itens) {
        inserir.run(
          arquivoId, fonteId, it.linhaPlanilha, it.acaoDespesa || null, f.competencia || null,
          it.grupo || null, it.codigo || null, it.acao || null, it.planoInterno || null,
          it.valorCentavos,
          textoDeBusca([it.grupo, it.codigo, it.acaoDespesa, it.acao, it.planoInterno, f.codigo])
        );
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

function importarPlanilha(buffer, nomeOriginal, mapeamento = null) {
  // A planilha padrao (uma aba por fonte) tem caminho proprio. O mapeamento
  // manual so existe para o formato antigo, entao ele desliga a deteccao.
  if (!mapeamento && /\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(nomeOriginal)) {
    let wb = null;
    try {
      wb = XLSX.read(buffer, { type: 'buffer' });
    } catch { /* nao e planilha legivel: segue pelo caminho antigo */ }
    if (wb && ehPlanilhaPorFonte(wb)) return importarPorFonte(buffer, nomeOriginal);
  }

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

  const resultado = emTransacao(() => {
    const totalCentavos = registros.reduce((s, r) => s + r.valorCentavos, 0);
    const competencia = registros.find((r) => r.competencia)?.competencia || null;

    const arq = db
      .prepare(`INSERT INTO arquivos (nome_original, competencia, total_linhas, valor_total_centavos)
                VALUES (?, ?, ?, ?)`)
      .run(nomeOriginal, competencia, registros.length, totalCentavos);
    const arquivoId = Number(arq.lastInsertRowid);

    const inserir = db.prepare(`
      INSERT INTO linhas
        (arquivo_id, fonte_id, linha_planilha, matricula, nome, cargo, lotacao,
         descricao, competencia, valor_centavos, dados_extra, busca_texto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const cacheFontes = new Map();
    const fontesTocadas = new Set();

    for (const r of registros) {
      const chave = normalizarTexto(r.fonte);
      let fonteId = cacheFontes.get(chave);
      if (fonteId === undefined) {
        fonteId = garantirFonte(r.fonte);
        cacheFontes.set(chave, fonteId);
      }
      fontesTocadas.add(fonteId);
      inserir.run(
        arquivoId, fonteId, r.linhaPlanilha, r.matricula || null, r.nome || null,
        r.cargo || null, r.lotacao || null, r.descricao || null, r.competencia || null,
        r.valorCentavos, r.dadosExtra,
        textoDeBusca([r.matricula, r.nome, r.cargo, r.lotacao, r.descricao, r.competencia, r.fonte])
      );
    }

    return { arquivoId, totalCentavos, fontes: fontesTocadas.size };
  });

  return {
    ok: true,
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

app.post('/api/arquivos', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

  if (/\.pdf$/i.test(req.file.originalname)) {
    return res.status(422).json({
      erro: 'PDF não pode ser importado direto no empenho. Use a aba '
        + '"Conversor para Excel" e depois clique em "Importar para o empenho".',
    });
  }

  try {
    res.json(importarPlanilha(req.file.buffer, req.file.originalname, lerMapeamento(req.body?.mapeamento)));
  } catch (e) {
    responderErroDeImportacao(res, e);
  }
});

app.get('/api/arquivos', (_req, res) => {
  const linhas = db.prepare(`
    SELECT a.id, a.nome_original AS nomeOriginal, a.competencia,
           a.total_linhas AS totalLinhas, a.valor_total_centavos AS valorTotalCentavos,
           a.enviado_em AS enviadoEm,
           COALESCE(SUM(CASE WHEN l.empenhado = 1 THEN 1 ELSE 0 END), 0) AS itensEmpenhados
    FROM arquivos a
    LEFT JOIN linhas l ON l.arquivo_id = a.id
    GROUP BY a.id
    ORDER BY a.id DESC
  `).all();
  res.json(linhas);
});

app.delete('/api/arquivos/:id', (req, res) => {
  const id = Number(req.params.id);
  const arq = db.prepare('SELECT id FROM arquivos WHERE id = ?').get(id);
  if (!arq) return res.status(404).json({ erro: 'Arquivo nao encontrado.' });
  emTransacao(() => {
    db.prepare('DELETE FROM linhas WHERE arquivo_id = ?').run(id);
    db.prepare('DELETE FROM arquivos WHERE id = ?').run(id);
  });
  res.json({ ok: true, fontes: listarFontes() });
});

/* ------------------------------------------------------------------ *
 * Fontes e teto orcamentario
 * ------------------------------------------------------------------ */

app.get('/api/fontes', (_req, res) => res.json(listarFontes()));

app.put('/api/fontes/:id/teto', (req, res) => {
  const id = Number(req.params.id);
  const fonte = db.prepare('SELECT id FROM fontes WHERE id = ?').get(id);
  if (!fonte) return res.status(404).json({ erro: 'Fonte nao encontrada.' });

  const teto = req.body?.tetoCentavos !== undefined
    ? Math.round(Number(req.body.tetoCentavos))
    : paraCentavos(req.body?.teto);

  if (!Number.isFinite(teto) || teto < 0) {
    return res.status(400).json({ erro: 'Teto invalido.' });
  }

  db.prepare(`UPDATE fontes SET teto_centavos = ?, atualizado_em = datetime('now','localtime') WHERE id = ?`)
    .run(teto, id);

  res.json({ ok: true, fonte: obterFonte(id) });
});

app.delete('/api/fontes/:id', (req, res) => {
  const id = Number(req.params.id);
  const qtd = db.prepare('SELECT COUNT(*) AS n FROM linhas WHERE fonte_id = ?').get(id);
  if (qtd.n > 0) {
    return res.status(409).json({ erro: 'A fonte ainda possui linhas importadas.' });
  }
  db.prepare('DELETE FROM fontes WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Linhas
 * ------------------------------------------------------------------ */

const SELECT_LINHA = `
  SELECT id, arquivo_id AS arquivoId, fonte_id AS fonteId, linha_planilha AS linhaPlanilha,
         matricula, nome, cargo, lotacao, descricao, competencia,
         grupo, codigo, acao, plano_interno AS planoInterno,
         valor_centavos AS valorCentavos, empenhado, empenhado_em AS empenhadoEm,
         dados_extra AS dadosExtra
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
function preencherBuscaPendente() {
  const pendentes = db.prepare(`
    SELECT id, ${CAMPOS_TEXTO.join(', ')} FROM linhas WHERE busca_texto IS NULL LIMIT 50000
  `).all();
  if (!pendentes.length) return;

  const atualizar = db.prepare('UPDATE linhas SET busca_texto = ? WHERE id = ?');
  emTransacao(() => {
    for (const l of pendentes) {
      atualizar.run(textoDeBusca(CAMPOS_TEXTO.map((c) => l[c])), l.id);
    }
  });
  console.log(`Índice de busca preenchido para ${pendentes.length} linha(s).`);
}

/**
 * Monta o filtro da barra de busca.
 *
 * Além do texto, aceita valor: "1.500,00", "1500,00" e "1500" encontram
 * R$ 1.500,00. A comparação é feita de duas formas — igualdade exata em
 * centavos e "contém" sobre o valor formatado (1500,00) — para achar tanto
 * o valor cheio quanto um pedaço dele.
 *
 * As condições de valor só entram quando o termo tem algum dígito; sem isso
 * uma busca por texto puro cairia em `valor_centavos = 0` e traria todos os
 * itens sem valor alocado.
 */
function filtroDeBusca(busca) {
  const termo = String(busca).trim();

  const partes = [`COALESCE(busca_texto,'') LIKE ?`];
  const valores = [`%${normalizarTexto(termo)}%`];

  if (/\d/.test(termo)) {
    // "R$ 1.500,00" -> "1500,00" (sem separador de milhar, vírgula decimal)
    const numerico = termo.replace(/[^\d,.]/g, '').replace(/\./g, '');
    const centavos = paraCentavos(termo);

    partes.push('valor_centavos = ?');
    valores.push(centavos);

    partes.push(`REPLACE(printf('%.2f', valor_centavos / 100.0), '.', ',') LIKE ?`);
    valores.push(`%${numerico}%`);
  }

  return { sql: `(${partes.join(' OR ')})`, valores };
}

/**
 * Uma fonte e "orcamentaria" quando suas linhas vem da planilha padrao
 * (tem Grupo / Plano Interno). Define o conjunto de colunas da tela.
 */
function formatoDaFonte(fonteId) {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM linhas
    WHERE fonte_id = ? AND (grupo IS NOT NULL OR plano_interno IS NOT NULL OR codigo IS NOT NULL)
  `).get(fonteId);
  return r.n > 0 ? 'orcamento' : 'folha';
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
    valorCentavos: l.valorCentavos,
    planoInterno: l.planoInterno || '',
    fonte: fonte?.codigo || fonte?.nome || '',
    // Colunas do formato de folha (planilha plana).
    matricula: l.matricula || '',
    nome: l.nome || '',
    cargo: l.cargo || '',
    lotacao: l.lotacao || '',
    descricao: l.descricao || '',
    competencia: l.competencia || '',
    empenhado: l.empenhado === 1,
    empenhadoEm: l.empenhadoEm,
    dadosExtra: l.dadosExtra,
  };
}

app.get('/api/fontes/:id/linhas', (req, res) => {
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

  const fonte = obterFonte(id);
  const linhas = db
    .prepare(`${SELECT_LINHA} WHERE ${cond.join(' AND ')} ORDER BY empenhado, id LIMIT 5000`)
    .all(...args)
    .map((l) => montarLinha(l, fonte));

  const formato = formatoDaFonte(id);
  res.json({
    fonte,
    formato,
    colunas: formato === 'orcamento' ? COLUNAS : null,
    linhas,
  });
});

/**
 * Empenha ou estorna um conjunto de linhas.
 * Body: { ids: number[], empenhado: boolean, forcar?: boolean, usuario?: string }
 * O teto e validado no servidor: se a operacao estourar o limite, a resposta
 * e 409 com o detalhamento (a menos que `forcar` seja true).
 */
app.post('/api/empenhos', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const empenhar = req.body?.empenhado !== false;
  const forcar = req.body?.forcar === true;
  const usuario = req.body?.usuario || 'operador';

  if (!ids.length) return res.status(400).json({ erro: 'Nenhum item informado.' });

  const marcadores = ids.map(() => '?').join(',');
  const alvo = db
    .prepare(`SELECT id, fonte_id AS fonteId, valor_centavos AS valorCentavos, empenhado
              FROM linhas WHERE id IN (${marcadores})`)
    .all(...ids);

  if (!alvo.length) return res.status(404).json({ erro: 'Itens nao encontrados.' });

  const fonteId = alvo[0].fonteId;
  if (alvo.some((l) => l.fonteId !== fonteId)) {
    return res.status(400).json({ erro: 'Todos os itens devem pertencer a mesma fonte.' });
  }

  // Somente as linhas que realmente mudam de estado entram na conta.
  const mudam = alvo.filter((l) => (l.empenhado === 1) !== empenhar);
  if (!mudam.length) {
    return res.json({ ok: true, alterados: 0, fonte: obterFonte(fonteId) });
  }

  const delta = mudam.reduce((s, l) => s + l.valorCentavos, 0);
  const fonte = obterFonte(fonteId);

  if (empenhar && fonte.tetoCentavos > 0 && !forcar) {
    const novoTotal = empenhadoDaFonte(fonteId) + delta;
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

  emTransacao(() => {
    const marcar = db.prepare(`
      UPDATE linhas
      SET empenhado = ?,
          empenhado_em = CASE WHEN ? = 1 THEN datetime('now','localtime') ELSE NULL END,
          empenhado_por = CASE WHEN ? = 1 THEN ? ELSE NULL END
      WHERE id = ?
    `);
    const flag = empenhar ? 1 : 0;
    for (const l of mudam) {
      marcar.run(flag, flag, flag, usuario, l.id);
      registrarMovimento(l.id, empenhar ? 'EMPENHO' : 'ESTORNO', l.valorCentavos, usuario);
    }
  });

  const atualizada = obterFonte(fonteId);
  res.json({
    ok: true,
    alterados: mudam.length,
    deltaCentavos: empenhar ? delta : -delta,
    forcado: forcar && empenhar,
    fonte: atualizada,
    linhas: db
      .prepare(`${SELECT_LINHA} WHERE id IN (${marcadores})`)
      .all(...ids)
      .map((l) => montarLinha(l, atualizada)),
  });
});

/* ------------------------------------------------------------------ *
 * Conversor de arquivos para Excel
 * ------------------------------------------------------------------ */

/*
 * Os arquivos convertidos ficam em memoria ate serem baixados ou importados.
 * Sao descartados apos 30 minutos — nada de lixo acumulando em disco.
 */
const convertidos = new Map();
const VALIDADE_CONVERSAO = 30 * 60 * 1000;

function limparConvertidosVencidos() {
  const agora = Date.now();
  for (const [id, item] of convertidos) {
    if (agora - item.criadoEm > VALIDADE_CONVERSAO) convertidos.delete(id);
  }
}
setInterval(limparConvertidosVencidos, 5 * 60 * 1000).unref();

function nomeDeSaida(nomeEntrada) {
  const base = String(nomeEntrada || 'arquivo').replace(/\.[^.]+$/, '');
  return `${base}.xlsx`;
}

app.post('/api/converter', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

  const opcoes = {
    umaAbaPorPagina: req.body?.umaAbaPorPagina === 'true',
    removerCabecalhosRepetidos: req.body?.removerCabecalhosRepetidos !== 'false',
  };

  try {
    const { buffer, resumo } = await converterParaXlsx(req.file.buffer, req.file.originalname, opcoes);

    limparConvertidosVencidos();
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const nomeSaida = nomeDeSaida(req.file.originalname);
    convertidos.set(id, { buffer, nomeSaida, criadoEm: Date.now() });

    res.json({
      ok: true,
      id,
      nomeEntrada: req.file.originalname,
      nomeSaida,
      tamanhoBytes: buffer.length,
      downloadUrl: `/api/converter/${id}/download`,
      ...resumo,
    });
  } catch (e) {
    res.status(422).json({ erro: e.message });
  }
});

app.get('/api/converter/:id/download', (req, res) => {
  const item = convertidos.get(req.params.id);
  if (!item) {
    return res.status(404).json({ erro: 'Conversão expirada ou inexistente. Converta o arquivo novamente.' });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(item.nomeSaida)}"`);
  res.send(item.buffer);
});

/** Manda o arquivo recem-convertido direto para o controle de empenho. */
app.post('/api/converter/:id/importar', (req, res) => {
  const item = convertidos.get(req.params.id);
  if (!item) {
    return res.status(404).json({ erro: 'Conversão expirada ou inexistente. Converta o arquivo novamente.' });
  }
  try {
    res.json(importarPlanilha(item.buffer, item.nomeSaida, lerMapeamento(req.body?.mapeamento)));
  } catch (e) {
    responderErroDeImportacao(res, e);
  }
});

/* ------------------------------------------------------------------ *
 * Resumo geral e exportacao
 * ------------------------------------------------------------------ */

app.get('/api/resumo', (_req, res) => {
  const fontes = listarFontes();
  const soma = (campo) => fontes.reduce((s, f) => s + f[campo], 0);
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
});

app.get('/api/fontes/:id/export.csv', (req, res) => {
  const id = Number(req.params.id);
  const fonte = obterFonte(id);
  if (!fonte) return res.status(404).json({ erro: 'Fonte nao encontrada.' });

  const brutas = db.prepare(`${SELECT_LINHA} WHERE fonte_id = ? ORDER BY id`).all(id);
  const linhas = brutas.map((l) => montarLinha(l, fonte));
  const orcamento = formatoDaFonte(id) === 'orcamento';

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
});

/* ------------------------------------------------------------------ */

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ erro: `Falha no upload: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

preencherBuscaPendente();

app.listen(PORT, () => {
  console.log(`Sistema de Empenho SEDUC rodando em http://localhost:${PORT}`);
});
