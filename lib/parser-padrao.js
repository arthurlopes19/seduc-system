'use strict';

/*
 * Leitor da planilha padrão de empenho (uma aba por Fonte).
 *
 * Estrutura esperada de cada aba:
 *
 *   linha 0  FONTE 1540107043 – IMPOSTOS – 70% - PESSOAL      <- título da aba na UI
 *   linha 1  160102 – FUNDEB – SEDUC – FOLHA:08/2026 – Nº1 …  <- contexto
 *   linha 2  (em branco)
 *   linha 3  GRUPO/NÍVEL | CÓDIGO | AÇÃO/DESPESA | AÇÃO | VALOR | PLANO INTERNO | FONTE
 *   linha 4  ADMINISTRATIVO / ADMINISTRATIVO / ADMINISTRATIVO <- linha de grupo
 *   linha 5           | 319004 | Contratação…  | 283508 | 972701.85 | 4110028339P | 1540107043
 *   …
 *            TOTAL ALOCADO NESTA FONTE |||| 146472259.69
 *            RESUMO DA FONTE
 *            Fonte                      | 1540107043
 *            Valor-meta da fonte        | 146472259.69   <- vira o TETO da fonte
 *            Total dos valores alocados | 146472259.69
 *            Diferença (Meta - Alocado) | 0
 *            Status                     | META ATINGIDA
 *
 * O "Grupo" é um cabeçalho de seção na planilha; aqui ele é propagado para
 * dentro de cada item, porque no sistema ele é uma COLUNA da tabela.
 */

const XLSX = require('xlsx');
const { chaveCabecalho, normalizarTexto, paraCentavos } = require('./util');

/** Ordem de colunas exigida na exibição. A Fonte é sempre a última. */
const COLUNAS = [
  { chave: 'grupo', rotulo: 'Grupo' },
  { chave: 'codigo', rotulo: 'Código' },
  { chave: 'acaoDespesa', rotulo: 'Ação/Despesa' },
  { chave: 'acao', rotulo: 'Ação' },
  { chave: 'valor', rotulo: 'Valor', tipo: 'moeda' },
  { chave: 'planoInterno', rotulo: 'Plano Interno' },
  { chave: 'fonte', rotulo: 'Fonte' },
];

/** Índices das colunas dentro da aba, na ordem em que a planilha as traz. */
const COL = {
  GRUPO: 0,
  CODIGO: 1,
  ACAO_DESPESA: 2,
  ACAO: 3,
  VALOR: 4,
  PLANO_INTERNO: 5,
  FONTE: 6,
};

const texto = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Localiza a linha de cabeçalho da tabela dentro da aba. */
function acharCabecalho(matriz) {
  for (let i = 0; i < Math.min(matriz.length, 15); i++) {
    const chaves = (matriz[i] || []).map((c) => chaveCabecalho(c));
    const tem = (alvo) => chaves.some((k) => k === alvo);
    if (tem('CODIGO') && tem('VALOR') && (tem('PLANOINTERNO') || tem('FONTE'))) return i;
  }
  return -1;
}

/**
 * Reconhece a planilha padrão: ao menos uma aba com "FONTE …" na primeira
 * linha e o cabeçalho de colunas logo abaixo.
 */
function ehPlanilhaPorFonte(workbook) {
  return workbook.SheetNames.some((nome) => {
    const matriz = XLSX.utils.sheet_to_json(workbook.Sheets[nome], {
      header: 1, raw: true, defval: '', blankrows: true,
    });
    if (!matriz.length) return false;
    const primeira = normalizarTexto(texto(matriz[0]?.[0]));
    return /^FONTE\b/.test(primeira) && acharCabecalho(matriz) !== -1;
  });
}

/**
 * Separa o título em código e descrição.
 * "FONTE 1540107043 – IMPOSTOS – 70% - PESSOAL"
 *   -> { codigo: '1540107043', titulo: 'IMPOSTOS – 70% - PESSOAL' }
 */
function interpretarTitulo(primeiraLinha, nomeDaAba) {
  const bruto = texto(primeiraLinha);
  const semPrefixo = bruto.replace(/^\s*FONTE\s*/i, '');
  const casa = semPrefixo.match(/^(\d[\d.\-/]*)\s*[–—-]*\s*(.*)$/);

  const codigo = casa ? casa[1].trim() : texto(nomeDaAba);
  const descricao = casa ? casa[2].trim() : semPrefixo.trim();

  return {
    codigo: codigo || texto(nomeDaAba),
    titulo: descricao || bruto || texto(nomeDaAba),
    tituloCompleto: bruto,
  };
}

/** "FOLHA:08/2026" -> "08/2026" */
function extrairCompetencia(contexto) {
  const casa = texto(contexto).match(/(\d{2}\/\d{4})/);
  return casa ? casa[1] : null;
}

/** Lê o bloco "RESUMO DA FONTE" que fecha cada aba. */
function lerResumo(matriz, inicio) {
  const resumo = {};
  for (let i = inicio; i < matriz.length; i++) {
    const rotulo = normalizarTexto(texto(matriz[i]?.[COL.GRUPO]));
    const valor = matriz[i]?.[COL.CODIGO];
    if (!rotulo) continue;

    if (rotulo === 'FONTE') resumo.codigo = texto(valor);
    else if (rotulo.startsWith('VALOR-META') || rotulo.startsWith('VALOR META')) {
      resumo.metaCentavos = paraCentavos(valor);
    } else if (rotulo.startsWith('TOTAL DOS VALORES ALOCADOS')) {
      resumo.alocadoCentavos = paraCentavos(valor);
    } else if (rotulo.startsWith('DIFERENCA')) {
      resumo.diferencaCentavos = paraCentavos(valor);
    } else if (rotulo === 'STATUS') {
      resumo.status = texto(valor);
    }
  }
  return resumo;
}

/** Processa uma aba da planilha. */
function processarAba(matriz, nomeDaAba) {
  const linhaCabecalho = acharCabecalho(matriz);
  if (linhaCabecalho === -1) return null;

  const { codigo, titulo, tituloCompleto } = interpretarTitulo(matriz[0]?.[COL.GRUPO], nomeDaAba);
  const contexto = texto(matriz[1]?.[COL.GRUPO]);

  const itens = [];
  const avisos = [];
  let grupoAtual = '';
  let totalAlocadoCentavos = null;
  let resumo = {};

  for (let i = linhaCabecalho + 1; i < matriz.length; i++) {
    const linha = matriz[i] || [];
    const celulas = linha.map(texto);
    if (!celulas.some((c) => c !== '')) continue;

    const primeira = celulas[COL.GRUPO];
    const rotulo = normalizarTexto(primeira);

    // Rodapé: total alocado e, em seguida, o bloco de resumo.
    if (rotulo.startsWith('TOTAL ALOCADO')) {
      totalAlocadoCentavos = paraCentavos(linha[COL.VALOR]);
      continue;
    }
    if (rotulo.startsWith('RESUMO DA FONTE')) {
      resumo = lerResumo(matriz, i + 1);
      break;
    }

    // Linha de grupo: só a primeira coluna preenchida. Passa a valer para
    // os itens seguintes, até aparecer outro grupo.
    const temCodigo = celulas[COL.CODIGO] !== '';
    if (!temCodigo && primeira !== '') {
      grupoAtual = primeira;
      continue;
    }
    if (!temCodigo) continue;

    const valorBruto = linha[COL.VALOR];
    const valorCentavos = paraCentavos(valorBruto);
    if (texto(valorBruto) === '') {
      avisos.push(`${nomeDaAba} linha ${i + 1}: item "${celulas[COL.ACAO_DESPESA]}" sem valor alocado.`);
    }

    itens.push({
      linhaPlanilha: i + 1,
      grupo: grupoAtual,
      codigo: celulas[COL.CODIGO],
      acaoDespesa: celulas[COL.ACAO_DESPESA],
      acao: celulas[COL.ACAO],
      valorCentavos,
      planoInterno: celulas[COL.PLANO_INTERNO],
      fonte: celulas[COL.FONTE] || codigo,
      semValor: texto(valorBruto) === '',
    });
  }

  const somaItensCentavos = itens.reduce((s, it) => s + it.valorCentavos, 0);

  // Conferência: a soma dos itens tem que bater com o total da própria planilha.
  if (totalAlocadoCentavos !== null && somaItensCentavos !== totalAlocadoCentavos) {
    avisos.push(
      `${nomeDaAba}: soma dos itens (${(somaItensCentavos / 100).toFixed(2)}) difere do `
      + `"TOTAL ALOCADO NESTA FONTE" (${(totalAlocadoCentavos / 100).toFixed(2)}).`
    );
  }

  return {
    aba: nomeDaAba,
    codigo,
    titulo,
    tituloCompleto,
    contexto,
    competencia: extrairCompetencia(contexto),
    colunas: COLUNAS,
    itens,
    quantidade: itens.length,
    itensSemValor: itens.filter((i) => i.semValor).length,
    somaItensCentavos,
    totalAlocadoCentavos,
    metaCentavos: resumo.metaCentavos ?? null,
    diferencaCentavos: resumo.diferencaCentavos ?? null,
    status: resumo.status || null,
    avisos,
  };
}

/**
 * Processa a planilha inteira.
 * Retorna { formato, fontes: [...], competencia, avisos }.
 */
function processarPlanilhaPorFonte(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  const fontes = [];
  const avisos = [];

  for (const nome of wb.SheetNames) {
    const matriz = XLSX.utils.sheet_to_json(wb.Sheets[nome], {
      header: 1, raw: true, defval: '', blankrows: true,
    });
    const fonte = processarAba(matriz, nome);
    if (!fonte) {
      avisos.push(`Aba "${nome}" ignorada: não tem o cabeçalho esperado (CÓDIGO / VALOR / PLANO INTERNO).`);
      continue;
    }
    if (!fonte.itens.length) {
      avisos.push(`Aba "${nome}" ignorada: nenhum item encontrado.`);
      continue;
    }
    avisos.push(...fonte.avisos);
    fontes.push(fonte);
  }

  if (!fontes.length) {
    throw new Error('Nenhuma aba no formato esperado (título "FONTE …" e colunas Grupo/Código/Valor).');
  }

  return {
    formato: 'orcamento',
    fontes,
    competencia: fontes.find((f) => f.competencia)?.competencia || null,
    totalCentavos: fontes.reduce((s, f) => s + f.somaItensCentavos, 0),
    metaTotalCentavos: fontes.reduce((s, f) => s + (f.metaCentavos || 0), 0),
    avisos: avisos.slice(0, 40),
  };
}

module.exports = { processarPlanilhaPorFonte, ehPlanilhaPorFonte, COLUNAS };
