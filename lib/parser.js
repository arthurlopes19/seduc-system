'use strict';

const XLSX = require('xlsx');
const { chaveCabecalho, normalizarTexto, paraCentavos } = require('./util');

/*
 * Mapeamento flexivel de cabecalhos: a planilha da folha muda de nome de
 * coluna com frequencia, entao aceitamos varios sinonimos. A ordem importa:
 * o primeiro sinonimo da lista tem prioridade.
 */
const ALIASES = {
  fonte: ['FONTE', 'FONTERECURSO', 'FONTEDERECURSO', 'FONTEDERECURSOS', 'CODFONTE',
          'CODIGOFONTE', 'FONTEPAGADORA', 'ORIGEMRECURSO', 'RECURSO'],
  valor: ['VALOR', 'VALORTOTAL', 'VALORLIQUIDO', 'VALORAPAGAR', 'VALOREMPENHO',
          'VLRTOTAL', 'VLR', 'LIQUIDO', 'TOTAL', 'VALORBRUTO'],
  nome: ['NOME', 'NOMESERVIDOR', 'SERVIDOR', 'NOMECOMPLETO', 'BENEFICIARIO',
         'FUNCIONARIO', 'CREDOR', 'FAVORECIDO'],
  matricula: ['MATRICULA', 'MATR', 'MAT', 'IDFUNCIONAL', 'CADASTRO', 'RE', 'CPF'],
  cargo: ['CARGO', 'FUNCAO', 'CARGOFUNCAO', 'VINCULO'],
  lotacao: ['LOTACAO', 'UNIDADEESCOLAR', 'UNIDADE', 'ESCOLA', 'SETOR', 'ORGAO', 'LOCAL'],
  descricao: ['DESCRICAO', 'VERBA', 'RUBRICA', 'EVENTO', 'HISTORICO', 'ESPECIFICACAO',
              'ELEMENTODESPESA', 'ELEMENTO', 'TIPO', 'TIPODESPESA'],
  competencia: ['COMPETENCIA', 'MESREFERENCIA', 'MESREF', 'REFERENCIA', 'MESANO', 'PERIODO'],
};

/** Le o buffer enviado e devolve uma matriz (array de arrays) de celulas. */
function lerMatriz(buffer, nomeArquivo) {
  const ext = String(nomeArquivo || '').toLowerCase().split('.').pop();

  if (ext === 'csv' || ext === 'txt') {
    return lerCSV(decodificar(buffer));
  }

  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const nomeAba = wb.SheetNames[0];
  if (!nomeAba) throw new Error('A planilha nao possui nenhuma aba.');
  const aba = wb.Sheets[nomeAba];
  // blankrows: true mantem o numero da linha igual ao da planilha original.
  return XLSX.utils.sheet_to_json(aba, { header: 1, raw: true, defval: '', blankrows: true });
}

/** UTF-8 quando valido; senao Windows-1252 (padrao dos exports legados). */
function decodificar(buffer) {
  let texto;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    texto = new TextDecoder('windows-1252').decode(buffer);
  }
  return texto.replace(/^﻿/, '');
}

function detectarDelimitador(texto) {
  const amostra = texto.split(/\r?\n/).slice(0, 10).join('\n');
  const candidatos = [';', ',', '\t', '|'];
  let melhor = ';';
  let melhorQtd = -1;
  for (const d of candidatos) {
    const qtd = amostra.split(d).length - 1;
    if (qtd > melhorQtd) { melhor = d; melhorQtd = qtd; }
  }
  return melhor;
}

/** CSV com suporte a aspas duplas e quebra de linha dentro do campo. */
function lerCSV(texto) {
  const d = detectarDelimitador(texto);
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else dentroAspas = false;
      } else {
        campo += c;
      }
      continue;
    }
    if (c === '"') { dentroAspas = true; continue; }
    if (c === d) { linha.push(campo); campo = ''; continue; }
    if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue; }
    if (c === '\r') continue;
    campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }

  return linhas;
}

/**
 * Descobre em qual linha esta o cabecalho (planilhas da folha costumam ter
 * titulo e linhas em branco antes) e mapeia campo -> indice da coluna.
 */
function detectarCabecalho(matriz) {
  const limite = Math.min(matriz.length, 60);
  let melhor = null;

  for (let i = 0; i < limite; i++) {
    const linha = matriz[i] || [];
    const mapa = {};
    let pontos = 0;

    const chaves = linha.map((v) => chaveCabecalho(v));

    // 1a passada: correspondencia exata do sinonimo.
    for (const [campo, sinonimos] of Object.entries(ALIASES)) {
      let melhorIdx = -1;
      let melhorRank = Infinity;
      for (let c = 0; c < chaves.length; c++) {
        if (!chaves[c]) continue;
        const rank = sinonimos.indexOf(chaves[c]);
        if (rank !== -1 && rank < melhorRank) { melhorRank = rank; melhorIdx = c; }
      }
      if (melhorIdx !== -1) { mapa[campo] = melhorIdx; pontos++; }
    }

    // 2a passada: so para o que sobrou, aceita cabecalho que comeca com o sinonimo
    // (ex.: "NOMESERVIDORCOMPLETO"). Nunca reutiliza coluna ja mapeada.
    const usadas = new Set(Object.values(mapa));
    for (const [campo, sinonimos] of Object.entries(ALIASES)) {
      if (mapa[campo] !== undefined) continue;
      for (let c = 0; c < chaves.length && mapa[campo] === undefined; c++) {
        if (!chaves[c] || usadas.has(c)) continue;
        if (sinonimos.some((s) => chaves[c].startsWith(s))) {
          mapa[campo] = c;
          usadas.add(c);
          pontos++;
        }
      }
    }

    // So vale como cabecalho se Fonte e Valor forem identificados.
    if (mapa.fonte !== undefined && mapa.valor !== undefined) {
      if (!melhor || pontos > melhor.pontos) {
        melhor = {
          indiceLinha: i,
          mapa,
          pontos,
          cabecalhos: linha.map((v) => String(v === null || v === undefined ? '' : v).trim()),
        };
      }
    }
  }

  return melhor;
}

/** Linhas de subtotal / rodape que nao devem virar registro. */
function ehLinhaDeTotal(celulas) {
  const texto = normalizarTexto(celulas.filter(Boolean).join(' '));
  return /^(TOTAL|TOTAIS|SUBTOTAL|SOMA)\b/.test(texto);
}

/** Fonte usada quando o conteudo da coluna nao serve como fonte de recurso. */
const FONTE_NAO_IDENTIFICADA = 'Não identificada';

/*
 * Relatorio em PDF costuma trazer, na mesma coluna da fonte, coisas que nao sao
 * fonte: rodape de pagina, linha de SALDO, o proprio somatorio. Sem esse filtro
 * cada um desses textos virava uma "fonte" nova no sistema.
 */
function fonteReconhecivel(valor) {
  const bruto = String(valor ?? '').trim();
  if (!bruto) return false;

  const texto = normalizarTexto(bruto);

  // Rotulos de rodape, total e saldo.
  if (/^(SALDO|TOTAL|TOTAIS|SUBTOTAL|SOMA|LIQUIDO|PAGINA|PAG|FOLHA|CONTINUA|RESUMO)\b/.test(texto)) {
    return false;
  }

  // Precisa ter ao menos uma letra ou digito ("#", "-", "---" nao servem).
  if (!/[A-Z0-9]/.test(texto)) return false;

  // Valor monetario disfarcado de fonte: (35.094.246,46) · 35.094.246,46 · 1389726.59
  const semSinais = bruto.replace(/[()\s]/g, '').replace(/^R\$/i, '');
  if (/^-?\d{1,3}(\.\d{3})*,\d{1,2}$/.test(semSinais)) return false;
  if (/^-?\d+[.,]\d{1,2}$/.test(semSinais)) return false;

  // Zeros.
  if (/^0+$/.test(semSinais)) return false;

  return true;
}

/** Amostra das primeiras linhas, para a tela de mapeamento manual. */
function montarAmostra(matriz, limiteLinhas = 30, limiteColunas = 25) {
  return matriz.slice(0, limiteLinhas).map((linha) =>
    Array.from({ length: Math.min(limiteColunas, Math.max(linha.length, 1)) }, (_, c) => {
      const v = linha[c];
      if (v === null || v === undefined) return '';
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
    })
  );
}

/**
 * Processa o arquivo enviado.
 *
 * `manual` permite pular a deteccao automatica quando a operadora aponta as
 * colunas na tela: { indiceLinha, mapa: { fonte: 3, valor: 5, ... } }.
 *
 * Retorna { cabecalhos, mapa, registros, ignoradas, avisos }.
 */
function processarPlanilha(buffer, nomeArquivo, manual = null) {
  const matriz = lerMatriz(buffer, nomeArquivo);
  if (!matriz.length) throw new Error('Arquivo vazio ou ilegivel.');

  let cab;
  if (manual && manual.mapa && manual.mapa.fonte !== undefined && manual.mapa.valor !== undefined) {
    const indiceLinha = Number(manual.indiceLinha) || 0;
    cab = {
      indiceLinha,
      mapa: manual.mapa,
      cabecalhos: (matriz[indiceLinha] || []).map((v) => String(v ?? '').trim()),
    };
  } else {
    cab = detectarCabecalho(matriz);
  }

  if (!cab) {
    const erro = new Error(
      'Não foi possível identificar as colunas obrigatórias automaticamente. '
      + 'A planilha precisa de uma coluna "Fonte" e uma coluna "Valor".'
    );
    erro.codigo = 'COLUNAS_NAO_IDENTIFICADAS';
    erro.amostra = montarAmostra(matriz);
    erro.totalLinhas = matriz.length;
    throw erro;
  }

  const { mapa, indiceLinha, cabecalhos } = cab;
  const mapeados = new Set(Object.values(mapa));
  const registros = [];
  const avisos = [];
  let ignoradas = 0;
  let naoIdentificadas = 0;

  const pegar = (linha, campo) => {
    const idx = mapa[campo];
    if (idx === undefined) return '';
    const v = linha[idx];
    if (v === null || v === undefined) return '';
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
  };

  for (let i = indiceLinha + 1; i < matriz.length; i++) {
    const linha = matriz[i] || [];
    const celulas = linha.map((v) => (v === null || v === undefined ? '' : String(v).trim()));
    if (!celulas.some((v) => v !== '')) continue;
    if (ehLinhaDeTotal(celulas)) { ignoradas++; continue; }

    const fonteBruta = pegar(linha, 'fonte');
    const valorCentavos = paraCentavos(linha[mapa.valor]);

    // Linha sem fonte e sem valor nao carrega informacao nenhuma.
    if (!fonteBruta && valorCentavos === 0) { ignoradas++; continue; }

    // Nada e descartado em silencio: o que nao serve como fonte vai para a
    // categoria "Não identificada", onde a operadora revisa depois.
    const reconhecida = fonteReconhecivel(fonteBruta);
    const fonte = reconhecida ? fonteBruta : FONTE_NAO_IDENTIFICADA;
    if (!reconhecida) naoIdentificadas++;

    if (valorCentavos === 0) {
      avisos.push(`Linha ${i + 1}: valor zerado ou nao reconhecido ("${pegar(linha, 'valor')}").`);
    }

    const extra = {};
    // Guarda o texto original para a operadora entender de onde veio a linha.
    if (!reconhecida && fonteBruta) extra['Fonte (não reconhecida)'] = fonteBruta;
    for (let c = 0; c < linha.length; c++) {
      if (mapeados.has(c)) continue;
      const rotulo = String(cabecalhos[c] || '').trim();
      const valor = linha[c];
      if (!rotulo || valor === '' || valor === null || valor === undefined) continue;
      extra[rotulo] = valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor).trim();
    }

    registros.push({
      linhaPlanilha: i + 1,
      fonte,
      matricula: pegar(linha, 'matricula'),
      nome: pegar(linha, 'nome'),
      cargo: pegar(linha, 'cargo'),
      lotacao: pegar(linha, 'lotacao'),
      descricao: pegar(linha, 'descricao'),
      competencia: pegar(linha, 'competencia'),
      valorCentavos,
      dadosExtra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    });
  }

  if (!registros.length) {
    const erro = new Error(
      'Nenhuma linha válida encontrada: a coluna indicada como "Fonte" está vazia '
      + 'em todas as linhas de dados.'
    );
    erro.codigo = 'COLUNAS_NAO_IDENTIFICADAS';
    erro.amostra = montarAmostra(matriz);
    erro.totalLinhas = matriz.length;
    throw erro;
  }

  return {
    cabecalhos,
    mapa,
    registros,
    ignoradas,
    naoIdentificadas,
    avisos: avisos.slice(0, 20),
  };
}

module.exports = {
  processarPlanilha, montarAmostra, lerMatriz, fonteReconhecivel,
  FONTE_NAO_IDENTIFICADA, ALIASES, lerCSV, decodificar,
};
