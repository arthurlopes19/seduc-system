'use strict';

/*
 * IMPORTAÇÃO 2 — Documento de empenho (o que a operadora vai pagar)
 *
 * Aceita as duas formas do mesmo conteúdo:
 *   · PDF   (mauro.pdf)      — assinado, uma aba única, colunas posicionais
 *   · XLSX  (padrao.xlsx)    — uma aba por fonte
 *
 * Layout do PDF:
 *   160102 – FUNDEB – SEDUC – FOLHA:08/2026 – No1
 *   GRUPO/NÍVEL                    AÇÃO    VALOR      PLANO INTERNO  FONTE
 *   ADMINISTRATIVO / ADMINISTRATIVO / ADMINISTRATIVO
 *   319004 – Contratação Por Tempo Determinado  283508  972.701,85  4110028339P  1540107043
 *   ...
 *   TOTAL 374.721.680,27
 *   FONTE DE RECURSOS            FOLHA           RECEITA         SALDO
 *   1540107043 – IMPOSTOS 70%    146.472.259,69  181.566.506,15  35.094.246,46
 *
 * A FONTE deste documento é a que vale — a que aparece no relatório da
 * Importação 1 não é usada.
 *
 * As colunas do PDF são separadas pelo FORMATO de cada campo, não pela
 * posição X: a coluna FONTE do cabeçalho fica alguns pontos à direita dos
 * dados, e cortar por posição perdia a última coluna.
 */

const XLSX = require('xlsx');
const { paraCentavos } = require('./util');
const { acharGrupo, normalizar } = require('./grupos');
const { lerLinhasComPosicao } = require('./posicao-pdf');

const RE_ITEM = /^(\d{6})\s*[–-]\s*(.*)$/;
const RE_ACAO = /^\d{6}$/;
const RE_VALOR = /^\(?-?[\d.]+,\d{2}\)?$/;
const RE_PLANO = /^(?=.*[A-Z])[0-9A-Z]{9,}$/i;
const RE_FONTE = /^0?\d{10}$/;
const RE_COMPETENCIA = /FOLHA:\s*(\d{2}\/\d{4})/i;

/** Linha do quadro final: "1540107043 – IMPOSTOS – 70% - PESSOAL 146.472,69 181.566,15 35.094,46" */
const RE_LINHA_FONTE = /^(0?\d{10})\s*[–-]\s*(.+?)\s+((?:\(?-?[\d.]+,\d{2}\)?\s*)+)$/;

/*
 * O cabeçalho do documento ("160102 – FUNDEB – SEDUC – FOLHA:08/2026 – No1")
 * começa com 6 dígitos e um traço, exatamente como um item, e tem uma barra
 * na competência, exatamente como um grupo. Precisa sair antes das duas
 * verificações, senão vira item fantasma em cada página.
 */
function ehCabecalhoDocumento(texto) {
  return /FOLHA:\s*\d{2}\/\d{4}/i.test(texto)
      || /Lan[çc]amentos filtrados/i.test(texto)
      // título da aba da planilha: "FONTE 1500100102 – TESOURO – PESSOAL/ODC"
      || /^FONTE\s+\d/i.test(String(texto).trim());
}

/** Normaliza o código da fonte: "01500100102" e "1500100102" são a mesma. */
function codigoFonte(bruto) {
  return String(bruto || '').replace(/\D/g, '').replace(/^0+(?=\d{10})/, '');
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

async function processarPdf(buffer) {
  const paginas = await lerLinhasComPosicao(buffer);

  const itens = [];
  const fontes = [];
  const avisos = [];
  let grupoAtual = null;
  let competencia = null;
  let totalDeclarado = null;
  let dentroDoQuadro = false;

  for (const pagina of paginas) {
    for (const { texto, pecas } of pagina.linhas) {
      if (!competencia) {
        const c = texto.match(RE_COMPETENCIA);
        if (c) competencia = c[1];
      }

      // rodapé de autenticação, cabeçalho de coluna e cabeçalho do documento
      // não são dados
      if (ehCabecalhoDocumento(texto)) continue;
      if (/ACESSADO POR|P[ÁA]GINA:\s*\d|GRUPO\/N[ÍI]VEL|Processo:|ASSINATURAS|assinado eletronicamente/i.test(texto)) continue;

      if (/^TOTAL\s+[\d.]+,\d{2}$/i.test(texto)) {
        totalDeclarado = paraCentavos(texto.replace(/^TOTAL\s+/i, ''));
        continue;
      }
      if (/FONTE DE RECURSOS/i.test(texto)) { dentroDoQuadro = true; continue; }

      if (dentroDoQuadro) {
        const mf = texto.match(RE_LINHA_FONTE);
        if (mf) {
          const numeros = mf[3].trim().split(/\s+/).map(paraCentavos);
          // Quando a fonte não tem receita, o documento omite a coluna do meio
          // e imprime só folha e saldo — este último entre parênteses (negativo).
          const [folha, receita, saldo] = numeros.length >= 3
            ? numeros
            : [numeros[0], 0, numeros[1] ?? 0];
          fontes.push({
            codigo: codigoFonte(mf[1]),
            titulo: mf[2].trim(),
            folhaCentavos: folha || 0,
            receitaCentavos: receita || 0,
            saldoCentavos: saldo || 0,
          });
        }
        continue;
      }

      const mItem = pecas.length ? pecas[0].texto.match(RE_ITEM) : null;
      if (!mItem) {
        if (texto.includes('/')) {
          const oficial = acharGrupo(texto);
          if (!oficial) avisos.push(`Grupo não reconhecido: "${texto}".`);
          grupoAtual = oficial
            ? { nome: oficial.nome, chave: oficial.chave, reconhecido: true }
            : { nome: texto.trim(), chave: normalizar(texto), reconhecido: false };
        }
        continue;
      }

      const resto = pecas.slice(1);
      const achar = (re) => resto.find((p) => re.test(p.texto))?.texto || '';

      itens.push({
        grupo: grupoAtual ? grupoAtual.nome : '',
        grupoChave: grupoAtual ? grupoAtual.chave : '',
        codigo: mItem[1],
        acaoDespesa: mItem[2].trim(),
        acao: achar(RE_ACAO),
        valorCentavos: paraCentavos(achar(RE_VALOR)),
        planoInterno: achar(RE_PLANO),
        fonte: codigoFonte(resto.filter((p) => RE_FONTE.test(p.texto)).pop()?.texto || ''),
        pagina: pagina.numero,
      });
    }
  }

  return { itens, fontes, competencia, totalDeclarado, avisos };
}

/* ------------------------------------------------------------------ *
 * XLSX (uma aba por fonte)
 * ------------------------------------------------------------------ */

function processarXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const itens = [];
  const fontes = [];
  const avisos = [];
  let competencia = null;

  for (const nomeAba of wb.SheetNames) {
    const matriz = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], {
      header: 1, raw: true, defval: '', blankrows: true,
    });
    if (!matriz.length) continue;

    const titulo = String(matriz[0]?.[0] || '');
    const casaTitulo = titulo.replace(/^\s*FONTE\s*/i, '').match(/^(\d[\d.\-/]*)\s*[–—-]*\s*(.*)$/);
    const codigo = codigoFonte(casaTitulo ? casaTitulo[1] : nomeAba);

    if (!competencia) {
      const c = String(matriz[1]?.[0] || '').match(/(\d{2}\/\d{4})/);
      if (c) competencia = c[1];
    }

    let grupoAtual = null;
    let metaCentavos = 0;
    let dentroResumo = false;

    for (const linha of matriz) {
      const c0 = String(linha[0] ?? '').trim();
      const c1 = linha[1];

      if (/^RESUMO DA FONTE/i.test(c0)) { dentroResumo = true; continue; }
      if (dentroResumo) {
        if (/^VALOR-?\s*META/i.test(normalizar(c0).replace(/\s/g, ' '))) metaCentavos = paraCentavos(c1);
        continue;
      }
      if (/^TOTAL ALOCADO/i.test(c0)) continue;

      if (ehCabecalhoDocumento(c0)) continue;

      const codigoItem = String(c1 ?? '').trim();
      if (c0 && !codigoItem && c0.includes('/')) {
        const oficial = acharGrupo(c0);
        if (!oficial) avisos.push(`Grupo não reconhecido: "${c0}".`);
        grupoAtual = oficial
          ? { nome: oficial.nome, chave: oficial.chave }
          : { nome: c0, chave: normalizar(c0) };
        continue;
      }
      if (!/^\d{6}$/.test(codigoItem)) continue;

      itens.push({
        grupo: grupoAtual ? grupoAtual.nome : '',
        grupoChave: grupoAtual ? grupoAtual.chave : '',
        codigo: codigoItem,
        acaoDespesa: String(linha[2] ?? '').trim(),
        acao: String(linha[3] ?? '').trim(),
        valorCentavos: paraCentavos(linha[4]),
        planoInterno: String(linha[5] ?? '').trim(),
        fonte: codigoFonte(linha[6] ?? codigo),
        pagina: null,
      });
    }

    fontes.push({
      codigo,
      titulo: (casaTitulo ? casaTitulo[2] : nomeAba).trim(),
      // A planilha traz a meta (= coluna FOLHA do PDF) e não tem a receita.
      folhaCentavos: metaCentavos,
      receitaCentavos: 0,
      saldoCentavos: 0,
    });
  }

  return { itens, fontes, competencia, totalDeclarado: null, avisos };
}

/* ------------------------------------------------------------------ */

/**
 * Processa o documento de empenho, seja PDF ou planilha.
 * Retorna { origem, competencia, itens, fontes, totalCentavos, ... }.
 */
async function processarEmpenho(buffer, nomeArquivo) {
  const ehPdf = /\.pdf$/i.test(nomeArquivo || '');
  const bruto = ehPdf ? await processarPdf(buffer) : processarXlsx(buffer);

  if (!bruto.itens.length) {
    throw new Error(
      'Nenhum item encontrado. Esperado o documento de empenho com as colunas '
      + 'Grupo/Nível, Ação, Valor, Plano Interno e Fonte.'
    );
  }

  const totalCentavos = bruto.itens.reduce((s, i) => s + i.valorCentavos, 0);
  const avisos = [...bruto.avisos];

  if (bruto.totalDeclarado !== null && bruto.totalDeclarado !== totalCentavos) {
    avisos.push(
      `A soma dos itens (${(totalCentavos / 100).toFixed(2)}) difere do TOTAL impresso `
      + `no documento (${(bruto.totalDeclarado / 100).toFixed(2)}).`
    );
  }

  // Total por grupo — é o que se compara com o relatório da folha.
  const porGrupo = new Map();
  for (const item of bruto.itens) {
    const atual = porGrupo.get(item.grupoChave);
    if (atual) { atual.totalCentavos += item.valorCentavos; atual.itens += 1; }
    else porGrupo.set(item.grupoChave, {
      grupo: item.grupo, chave: item.grupoChave, totalCentavos: item.valorCentavos, itens: 1,
    });
  }

  return {
    origem: ehPdf ? 'PDF' : 'XLSX',
    competencia: bruto.competencia,
    itens: bruto.itens,
    fontes: bruto.fontes,
    grupos: [...porGrupo.values()],
    totalCentavos,
    totalDeclaradoCentavos: bruto.totalDeclarado,
    avisos: avisos.slice(0, 30),
  };
}

module.exports = { processarEmpenho, codigoFonte };
