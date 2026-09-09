'use strict';

/*
 * Aba "Importe" — duas importações e a consolidação entre elas.
 *
 *   Importação 1 · relatório da folha (PDF)      -> o que a folha pagou
 *   Importação 2 · documento de empenho (PDF/XLSX) -> o que tem que ser pago
 *
 * A ligação é o GRUPO (GRUPO / NÍVEL / MODALIDADE). Os 67 grupos oficiais são
 * a espinha dorsal: mesmo um grupo ausente nos dois documentos aparece na
 * consolidação, zerado, para não sumir da conferência.
 *
 * A FONTE válida é sempre a da Importação 2.
 */

const { db, agora } = require('../db');
const { CATALOGO, normalizar } = require('./grupos');
const { processarRelatorioFolha } = require('./parser-folha');
const { processarEmpenho } = require('./parser-empenho');

const TIPOS = { FOLHA: 'folha', EMPENHO: 'empenho' };

/* ------------------------------------------------------------------ *
 * Gravação
 * ------------------------------------------------------------------ */

/** Só um importe ativo de cada tipo: o novo substitui o anterior. */
async function substituirImporte(tipo, dados, gravarDetalhe) {
  return db.emTransacao(async (tx) => {
    const antigos = await tx.consulta('SELECT id FROM importes WHERE tipo = ?', [tipo]);
    for (const a of antigos) {
      for (const tabela of ['importe_grupos', 'importe_naturezas', 'importe_itens', 'importe_fontes']) {
        await tx.executar(`DELETE FROM ${tabela} WHERE importe_id = ?`, [a.id]);
      }
      await tx.executar('DELETE FROM importes WHERE id = ?', [a.id]);
    }

    const novo = await tx.executar(
      `INSERT INTO importes
         (tipo, nome_arquivo, origem, competencia, total_centavos, liquido_centavos, itens, avisos, enviado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [tipo, dados.nomeArquivo, dados.origem || null, dados.competencia || null,
       dados.totalCentavos, dados.liquidoCentavos || 0, dados.itens || 0,
       JSON.stringify(dados.avisos || []), agora()]
    );

    await gravarDetalhe(tx, novo.id);
    return novo.id;
  });
}

/** Importação 1 — relatório da folha. */
async function importarFolha(buffer, nomeArquivo) {
  const r = await processarRelatorioFolha(buffer);

  const importeId = await substituirImporte(TIPOS.FOLHA, {
    nomeArquivo,
    origem: 'PDF',
    competencia: r.competencia,
    totalCentavos: r.totalCentavos,
    liquidoCentavos: r.liquidoCentavos,
    itens: r.naturezas.length,
    avisos: r.avisos,
  }, async (tx, id) => {
    for (const g of r.grupos) {
      await tx.executar(
        `INSERT INTO importe_grupos
           (importe_id, grupo, grupo_chave, reconhecido, total_centavos, liquido_centavos, itens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, g.grupo, g.chave, g.reconhecido ? 1 : 0, g.totalCentavos, g.liquidoCentavos, g.folhas]
      );
    }
    for (const n of r.naturezas) {
      await tx.executar(
        `INSERT INTO importe_naturezas
           (importe_id, natureza, descricao, grupo_chave, fonte_relatorio,
            total_centavos, rpps_centavos, rgps_centavos, militar_centavos, outros_centavos, pagina)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, n.natureza, n.descricao, null, n.fonteRelatorio,
         n.totalCentavos, n.rppsCentavos, n.rgpsCentavos, n.militarCentavos, n.outrosCentavos, n.pagina]
      );
    }
  });

  return {
    ok: true,
    importeId,
    tipo: TIPOS.FOLHA,
    competencia: r.competencia,
    paginas: r.paginas,
    grupos: r.grupos.length,
    naturezas: r.naturezas.length,
    totalCentavos: r.totalCentavos,
    liquidoCentavos: r.liquidoCentavos,
    avisos: r.avisos,
  };
}

/** Importação 2 — documento de empenho. */
async function importarEmpenho(buffer, nomeArquivo) {
  const r = await processarEmpenho(buffer, nomeArquivo);

  const importeId = await substituirImporte(TIPOS.EMPENHO, {
    nomeArquivo,
    origem: r.origem,
    competencia: r.competencia,
    totalCentavos: r.totalCentavos,
    itens: r.itens.length,
    avisos: r.avisos,
  }, async (tx, id) => {
    for (const g of r.grupos) {
      await tx.executar(
        `INSERT INTO importe_grupos
           (importe_id, grupo, grupo_chave, reconhecido, total_centavos, liquido_centavos, itens)
         VALUES (?, ?, ?, 1, ?, 0, ?)`,
        [id, g.grupo, g.chave, g.totalCentavos, g.itens]
      );
    }
    for (const i of r.itens) {
      await tx.executar(
        `INSERT INTO importe_itens
           (importe_id, grupo, grupo_chave, codigo, acao_despesa, acao, valor_centavos, plano_interno, fonte)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, i.grupo, i.grupoChave, i.codigo, i.acaoDespesa, i.acao, i.valorCentavos, i.planoInterno, i.fonte]
      );
    }
    for (const f of r.fontes) {
      await tx.executar(
        `INSERT INTO importe_fontes (importe_id, codigo, titulo, folha_centavos, receita_centavos, saldo_centavos)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, f.codigo, f.titulo, f.folhaCentavos, f.receitaCentavos, f.saldoCentavos]
      );
    }
  });

  return {
    ok: true,
    importeId,
    tipo: TIPOS.EMPENHO,
    origem: r.origem,
    competencia: r.competencia,
    itens: r.itens.length,
    grupos: r.grupos.length,
    fontes: r.fontes.length,
    totalCentavos: r.totalCentavos,
    totalDeclaradoCentavos: r.totalDeclaradoCentavos,
    avisos: r.avisos,
  };
}

/* ------------------------------------------------------------------ *
 * Consolidação
 * ------------------------------------------------------------------ */

async function obterImporte(tipo) {
  return db.um(
    `SELECT id, tipo, nome_arquivo AS "nomeArquivo", origem, competencia,
            total_centavos AS "totalCentavos", liquido_centavos AS "liquidoCentavos",
            itens, avisos, enviado_em AS "enviadoEm"
       FROM importes WHERE tipo = ?`, [tipo]
  );
}

/**
 * Junta as duas importações pelo grupo.
 *
 * A situação de cada grupo:
 *   confere            — os dois valores batem
 *   NÃO SAIU NA FOLHA  — tem empenho previsto, mas a folha não pagou
 *   saiu a menor/maior — pagou diferente do previsto
 *   fora do empenho    — a folha pagou algo que não estava previsto
 *   sem movimento      — zerado nos dois (grupo existe, mas não foi usado)
 */
async function consolidar() {
  const [folha, empenho] = await Promise.all([
    obterImporte(TIPOS.FOLHA), obterImporte(TIPOS.EMPENHO),
  ]);

  const totaisPorChave = async (importeId) => {
    const mapa = new Map();
    if (!importeId) return mapa;
    const linhas = await db.consulta(
      `SELECT grupo_chave AS "chave", total_centavos AS "total", itens
         FROM importe_grupos WHERE importe_id = ?`, [importeId]
    );
    for (const l of linhas) mapa.set(l.chave, { total: Number(l.total), itens: Number(l.itens) });
    return mapa;
  };

  const [mapaFolha, mapaEmpenho] = await Promise.all([
    totaisPorChave(folha?.id), totaisPorChave(empenho?.id),
  ]);

  const grupos = CATALOGO.map(({ nome, chave }) => {
    const e = mapaEmpenho.get(chave);
    const f = mapaFolha.get(chave);
    const empenhoCentavos = e ? e.total : 0;
    const folhaCentavos = f ? f.total : 0;
    const diferencaCentavos = empenhoCentavos - folhaCentavos;

    let situacao = 'confere';
    if (!empenhoCentavos && !folhaCentavos) situacao = 'sem movimento';
    else if (empenhoCentavos && !folhaCentavos) situacao = 'não saiu na folha';
    else if (!empenhoCentavos && folhaCentavos) situacao = 'fora do empenho';
    else if (diferencaCentavos > 0) situacao = 'saiu a menor';
    else if (diferencaCentavos < 0) situacao = 'saiu a maior';

    return {
      grupo: nome,
      chave,
      empenhoCentavos,
      folhaCentavos,
      diferencaCentavos,
      itens: e ? e.itens : 0,
      situacao,
    };
  });

  // Grupos que apareceram nos documentos mas não estão na lista oficial.
  const conhecidas = new Set(CATALOGO.map((g) => g.chave));
  const forasteiros = [];
  for (const [chave, v] of mapaEmpenho) {
    if (!conhecidas.has(chave)) forasteiros.push({ chave, origem: 'empenho', totalCentavos: v.total });
  }
  for (const [chave, v] of mapaFolha) {
    if (!conhecidas.has(chave)) forasteiros.push({ chave, origem: 'folha', totalCentavos: v.total });
  }

  const fontes = empenho
    ? (await db.consulta(
        `SELECT codigo, titulo,
                folha_centavos   AS "folhaCentavos",
                receita_centavos AS "receitaCentavos",
                saldo_centavos   AS "saldoCentavos"
           FROM importe_fontes WHERE importe_id = ? ORDER BY codigo`, [empenho.id]
      )).map((f) => ({
        ...f,
        folhaCentavos: Number(f.folhaCentavos),
        receitaCentavos: Number(f.receitaCentavos),
        saldoCentavos: Number(f.saldoCentavos),
      }))
    : [];

  const soma = (campo) => grupos.reduce((s, g) => s + g[campo], 0);
  const comDiferenca = grupos.filter((g) => g.diferencaCentavos !== 0);

  return {
    importacoes: {
      folha: folha ? { ...folha, avisos: JSON.parse(folha.avisos || '[]') } : null,
      empenho: empenho ? { ...empenho, avisos: JSON.parse(empenho.avisos || '[]') } : null,
    },
    grupos,
    fontes,
    forasteiros,
    totais: {
      empenhoCentavos: soma('empenhoCentavos'),
      folhaCentavos: soma('folhaCentavos'),
      diferencaCentavos: soma('diferencaCentavos'),
      receitaCentavos: fontes.reduce((s, f) => s + f.receitaCentavos, 0),
      saldoFonteCentavos: fontes.reduce((s, f) => s + f.saldoCentavos, 0),
      gruposConferem: grupos.filter((g) => g.situacao === 'confere').length,
      gruposSemMovimento: grupos.filter((g) => g.situacao === 'sem movimento').length,
      gruposComDiferenca: comDiferenca.length,
    },
  };
}

/** Detalhe de um grupo: os itens do empenho e as naturezas da folha. */
async function detalharGrupo(chave) {
  const [folha, empenho] = await Promise.all([
    obterImporte(TIPOS.FOLHA), obterImporte(TIPOS.EMPENHO),
  ]);

  const itens = empenho
    ? await db.consulta(
        `SELECT codigo, acao_despesa AS "acaoDespesa", acao,
                valor_centavos AS "valorCentavos", plano_interno AS "planoInterno", fonte
           FROM importe_itens WHERE importe_id = ? AND grupo_chave = ?
          ORDER BY codigo, fonte`, [empenho.id, chave]
      )
    : [];

  const grupoFolha = folha
    ? await db.um(
        `SELECT grupo, total_centavos AS "totalCentavos", liquido_centavos AS "liquidoCentavos", itens
           FROM importe_grupos WHERE importe_id = ? AND grupo_chave = ?`, [folha.id, chave]
      )
    : null;

  return {
    itens: itens.map((i) => ({ ...i, valorCentavos: Number(i.valorCentavos) })),
    folha: grupoFolha ? {
      ...grupoFolha,
      totalCentavos: Number(grupoFolha.totalCentavos),
      liquidoCentavos: Number(grupoFolha.liquidoCentavos),
    } : null,
  };
}

/** Naturezas de despesa da Importação 1 (código, valores separados, total). */
async function listarNaturezas() {
  const folha = await obterImporte(TIPOS.FOLHA);
  if (!folha) return { naturezas: [], totalCentavos: 0 };

  const naturezas = await db.consulta(
    `SELECT natureza, descricao,
            SUM(total_centavos)   AS "totalCentavos",
            SUM(rpps_centavos)    AS "rppsCentavos",
            SUM(rgps_centavos)    AS "rgpsCentavos",
            SUM(militar_centavos) AS "militarCentavos",
            SUM(outros_centavos)  AS "outrosCentavos",
            COUNT(*)              AS "blocos"
       FROM importe_naturezas WHERE importe_id = ?
      GROUP BY natureza, descricao ORDER BY natureza`, [folha.id]
  );

  /*
   * O mesmo código aparece com descrições diferentes ao longo do relatório
   * (3.1.90.11.01 vem como "DESPESAS CORRENTES" e como "VENCIMENTOS E
   * SALARIOS"). Junta por código e fica com a descrição do maior valor.
   */
  const porCodigo = new Map();
  for (const n of naturezas) {
    const total = Number(n.totalCentavos);
    const atual = porCodigo.get(n.natureza);
    if (!atual) {
      porCodigo.set(n.natureza, {
        natureza: n.natureza,
        descricao: n.descricao,
        // Sem os pontos e sem o subitem, é o código do documento de empenho:
        // 3.1.90.11.06 -> 319011.
        codigoEmpenho: n.natureza.replace(/\./g, '').slice(0, 6),
        maiorDescricao: total,
        descricoes: 1,
        totalCentavos: total,
        rppsCentavos: Number(n.rppsCentavos),
        rgpsCentavos: Number(n.rgpsCentavos),
        militarCentavos: Number(n.militarCentavos),
        outrosCentavos: Number(n.outrosCentavos),
        blocos: Number(n.blocos),
      });
      continue;
    }
    if (total > atual.maiorDescricao) {
      atual.descricao = n.descricao;
      atual.maiorDescricao = total;
    }
    atual.descricoes += 1;
    atual.totalCentavos += total;
    atual.rppsCentavos += Number(n.rppsCentavos);
    atual.rgpsCentavos += Number(n.rgpsCentavos);
    atual.militarCentavos += Number(n.militarCentavos);
    atual.outrosCentavos += Number(n.outrosCentavos);
    atual.blocos += Number(n.blocos);
  }

  const numerico = [...porCodigo.values()]
    .map(({ maiorDescricao, ...resto }) => resto)
    .sort((a, b) => a.natureza.localeCompare(b.natureza));

  return {
    naturezas: numerico,
    totalCentavos: numerico.reduce((s, n) => s + n.totalCentavos, 0),
  };
}

async function limpar(tipo) {
  const alvo = await obterImporte(tipo);
  if (!alvo) return false;
  await db.emTransacao(async (tx) => {
    for (const tabela of ['importe_grupos', 'importe_naturezas', 'importe_itens', 'importe_fontes']) {
      await tx.executar(`DELETE FROM ${tabela} WHERE importe_id = ?`, [alvo.id]);
    }
    await tx.executar('DELETE FROM importes WHERE id = ?', [alvo.id]);
  });
  return true;
}


/* ------------------------------------------------------------------ *
 * Consolidação para a base de empenho
 * ------------------------------------------------------------------ */

/** Identidade de um item entre reimportações — o que permite não perder o empenho já marcado. */
function chaveItem(i) {
  return [i.fonte, i.codigo, i.acao, i.planoInterno, i.grupoChave].join('|');
}

/**
 * Transforma a Importação 2 na base de trabalho da aba Empenho.
 *
 * As fontes saem do quadro do documento — inclusive o TETO, que passa a ser
 * a RECEITA disponível e não a folha prevista. Com a folha como teto o saldo
 * daria zero sempre, e o controle não controlaria nada.
 *
 * Os itens já empenhados são reconhecidos pela combinação
 * fonte + código + ação + plano interno + grupo, e a marcação é devolvida
 * depois da recarga: reconsolidar não faz a operadora refazer o trabalho.
 */
async function consolidarParaEmpenho({ tetoPor = 'receita' } = {}) {
  const empenho = await obterImporte(TIPOS.EMPENHO);
  if (!empenho) {
    throw Object.assign(new Error('Importe o documento de empenho (Importação 2) antes de consolidar.'), { status: 400 });
  }

  const [itens, fontesDoc] = await Promise.all([
    db.consulta(
      `SELECT grupo, grupo_chave AS "grupoChave", codigo, acao_despesa AS "acaoDespesa",
              acao, valor_centavos AS "valorCentavos", plano_interno AS "planoInterno", fonte
         FROM importe_itens WHERE importe_id = ? ORDER BY id`, [empenho.id]
    ),
    db.consulta(
      `SELECT codigo, titulo, folha_centavos AS "folhaCentavos",
              receita_centavos AS "receitaCentavos"
         FROM importe_fontes WHERE importe_id = ?`, [empenho.id]
    ),
  ]);

  // Quadro de fontes por código: pode ter duas linhas para o mesmo código
  // (TESOURO PESSOAL e TESOURO ODC), que somam.
  const porCodigo = new Map();
  for (const f of fontesDoc) {
    const atual = porCodigo.get(f.codigo);
    if (atual) {
      atual.folhaCentavos += Number(f.folhaCentavos);
      atual.receitaCentavos += Number(f.receitaCentavos);
    } else {
      porCodigo.set(f.codigo, {
        codigo: f.codigo,
        titulo: f.titulo,
        folhaCentavos: Number(f.folhaCentavos),
        receitaCentavos: Number(f.receitaCentavos),
      });
    }
  }

  const resultado = await db.emTransacao(async (tx) => {
    // 1. guarda o que já estava empenhado
    const jaEmpenhados = await tx.consulta(`
      SELECT f.codigo AS fonte, l.codigo, l.acao, l.plano_interno AS "planoInterno", l.grupo
        FROM linhas l JOIN fontes f ON f.id = l.fonte_id
       WHERE l.empenhado = 1
    `);
    const marcados = new Set(jaEmpenhados.map((l) => chaveItem({
      fonte: l.fonte, codigo: l.codigo, acao: l.acao,
      planoInterno: l.planoInterno, grupoChave: normalizar(l.grupo),
    })));

    // 2. limpa a base antiga (as fontes ficam: guardam o teto)
    await tx.executar('DELETE FROM movimentos', []);
    await tx.executar('DELETE FROM linhas', []);
    await tx.executar('DELETE FROM arquivos', []);

    // 3. lote novo
    const totalCentavos = itens.reduce((s, i) => s + Number(i.valorCentavos), 0);
    const arq = await tx.executar(
      `INSERT INTO arquivos (nome_original, competencia, total_linhas, valor_total_centavos, enviado_em)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [`Consolidado ${empenho.competencia || ''}`.trim(), empenho.competencia,
       itens.length, totalCentavos, agora()]
    );

    // 4. fontes, com o teto vindo do quadro do documento
    const idPorCodigo = new Map();
    for (const f of porCodigo.values()) {
      /*
       * Receita zero é informação, não ausência de dado: a fonte ETI paga
       * folha sem receita própria (o documento mostra saldo negativo nela,
       * coberto pela sobra da 1540107043). Cair para a folha inventaria um
       * teto que não existe e inflaria o total em R$ 35 milhões.
       */
      const teto = tetoPor === 'folha' ? f.folhaCentavos : f.receitaCentavos;
      const norm = normalizar(f.codigo);
      const existente = await tx.um(
        'SELECT id FROM fontes WHERE codigo = ? OR nome_normalizado = ?', [f.codigo, norm]
      );
      if (existente) {
        await tx.executar(
          `UPDATE fontes SET nome = ?, codigo = ?, titulo = ?, meta_centavos = ?,
                             teto_centavos = ?, atualizado_em = ?
            WHERE id = ?`,
          [f.titulo, f.codigo, f.titulo, f.folhaCentavos, teto, agora(), existente.id]
        );
        idPorCodigo.set(f.codigo, existente.id);
      } else {
        const nova = await tx.executar(
          `INSERT INTO fontes (nome, nome_normalizado, codigo, titulo, meta_centavos, teto_centavos, criado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [f.titulo, norm, f.codigo, f.titulo, f.folhaCentavos, teto, agora()]
        );
        idPorCodigo.set(f.codigo, nova.id);
      }
    }

    // 5. os itens viram linhas empenháveis
    const SQL = `
      INSERT INTO linhas
        (arquivo_id, fonte_id, linha_planilha, descricao, competencia, grupo, codigo,
         acao, plano_interno, valor_centavos, empenhado, empenhado_em, empenhado_por, busca_texto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    let restaurados = 0;
    let semFonte = 0;

    for (const [indice, i] of itens.entries()) {
      let fonteId = idPorCodigo.get(i.fonte);
      if (!fonteId) {
        // Item cuja fonte não aparece no quadro final: cria a fonte pelo código.
        const norm = normalizar(i.fonte || 'SEM FONTE');
        const achada = await tx.um('SELECT id FROM fontes WHERE codigo = ? OR nome_normalizado = ?', [i.fonte, norm]);
        if (achada) fonteId = achada.id;
        else {
          const nova = await tx.executar(
            `INSERT INTO fontes (nome, nome_normalizado, codigo, titulo, criado_em)
             VALUES (?, ?, ?, ?, ?) RETURNING id`,
            [i.fonte || 'Sem fonte', norm, i.fonte || null, i.fonte || 'Sem fonte', agora()]
          );
          fonteId = nova.id;
        }
        idPorCodigo.set(i.fonte, fonteId);
        semFonte += 1;
      }

      const estava = marcados.has(chaveItem(i));
      if (estava) restaurados += 1;

      await tx.executar(SQL, [
        arq.id, fonteId, indice + 1, i.acaoDespesa || null, empenho.competencia || null,
        i.grupo || null, i.codigo || null, i.acao || null, i.planoInterno || null,
        Number(i.valorCentavos),
        estava ? 1 : 0, estava ? agora() : null, estava ? 'operador' : null,
        normalizar([i.grupo, i.codigo, i.acaoDespesa, i.acao, i.planoInterno, i.fonte]
          .filter(Boolean).join(' ')),
      ]);
    }

    return {
      arquivoId: arq.id,
      linhas: itens.length,
      totalCentavos,
      fontes: idPorCodigo.size,
      restaurados,
      fontesForaDoQuadro: semFonte,
    };
  });

  return { ok: true, tetoPor, competencia: empenho.competencia, ...resultado };
}

module.exports = {
  TIPOS, importarFolha, importarEmpenho, consolidar, consolidarParaEmpenho,
  detalharGrupo, listarNaturezas, limpar,
};
