'use strict';

/*
 * Conversor de arquivos para Excel (.xlsx).
 *
 * Suporta:
 *   PDF                -> reconstrucao da tabela a partir da posicao do texto
 *   CSV / TXT          -> deteccao de separador e codificacao
 *   XLS / XLSX / ODS   -> reemissao como xlsx (todas as abas)
 *
 * PDFs digitalizados (imagem pura) nao sao suportados: nao ha OCR aqui.
 */

const XLSX = require('xlsx');
const { lerCSV, decodificar } = require('./parser');

/* ------------------------------------------------------------------ *
 * PDF -> matriz de celulas
 * ------------------------------------------------------------------ */

/** Largura minima (em pontos) de um "corredor" vertical em branco para
 *  ser considerado separador de colunas. */
const GAP_MINIMO = 5;

/** Tolerancia vertical (pontos) para considerar que dois trechos de texto
 *  estao na mesma linha. */
const TOLERANCIA_LINHA = 3;

let pdfjsPromise = null;
function carregarPdfjs() {
  // pdfjs-dist e ESM; carregado sob demanda para nao pesar o boot do servidor.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/** Extrai os trechos de texto de cada pagina com suas coordenadas. */
async function extrairTrechos(buffer) {
  const pdfjs = await carregarPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const paginas = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const pagina = await doc.getPage(n);
      const conteudo = await pagina.getTextContent();
      const trechos = [];

      for (const item of conteudo.items) {
        const texto = (item.str || '').replace(/\s+/g, ' ').trim();
        if (!texto) continue;
        const x = item.transform[4];
        const y = item.transform[5];
        const largura = item.width || texto.length * 4;
        const altura = item.height || Math.abs(item.transform[3]) || 10;
        trechos.push({ texto, x, y, largura, altura, fim: x + largura });
      }

      paginas.push({ numero: n, trechos });
      pagina.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  return paginas;
}

/** Agrupa os trechos de uma pagina em linhas (mesma coordenada Y). */
function agruparEmLinhas(trechos) {
  const ordenados = [...trechos].sort((a, b) => b.y - a.y || a.x - b.x);
  const linhas = [];

  for (const t of ordenados) {
    const tolerancia = Math.max(TOLERANCIA_LINHA, t.altura * 0.35);
    const atual = linhas[linhas.length - 1];
    if (atual && Math.abs(atual.y - t.y) <= tolerancia) {
      atual.trechos.push(t);
      atual.y = (atual.y * (atual.trechos.length - 1) + t.y) / atual.trechos.length;
    } else {
      linhas.push({ y: t.y, trechos: [t] });
    }
  }

  for (const l of linhas) l.trechos.sort((a, b) => a.x - b.x);
  return linhas;
}

/**
 * Descobre as colunas procurando "corredores" verticais em branco.
 * Funciona tanto com texto alinhado a esquerda quanto a direita (valores),
 * ao contrario do agrupamento por coordenada inicial.
 *
 * Linhas com um unico trecho (titulos, rodapes) nao entram no calculo,
 * senao um titulo largo apagaria todos os corredores.
 */
function detectarColunas(linhasDeTodasAsPaginas, gapMinimo = GAP_MINIMO) {
  let limite = 0;
  const ocupado = [];

  const marcar = (inicio, fim) => {
    const a = Math.max(0, Math.floor(inicio));
    const b = Math.ceil(fim);
    for (let i = a; i < b; i++) ocupado[i] = true;
    if (b > limite) limite = b;
  };

  for (const linha of linhasDeTodasAsPaginas) {
    if (linha.trechos.length < 2) continue;
    for (const t of linha.trechos) marcar(t.x, t.fim);
  }

  if (!limite) return null;

  // A margem em branco antes da primeira e depois da ultima coluna nao e
  // separador — sem isso o Excel ganharia uma coluna vazia na esquerda.
  let primeiro = ocupado.findIndex(Boolean);
  if (primeiro === -1) return null;
  let ultimo = limite;
  while (ultimo > primeiro && !ocupado[ultimo - 1]) ultimo--;

  // Corredores em branco largos o suficiente viram fronteiras de coluna.
  const fronteiras = [];
  let inicioVazio = null;
  for (let i = primeiro; i <= ultimo; i++) {
    if (!ocupado[i]) {
      if (inicioVazio === null) inicioVazio = i;
    } else if (inicioVazio !== null) {
      if (i - inicioVazio >= gapMinimo) fronteiras.push((inicioVazio + i) / 2);
      inicioVazio = null;
    }
  }

  // Faixas [inicio, fim) de cada coluna.
  const cortes = [-Infinity, ...fronteiras, Infinity];
  return cortes.slice(0, -1).map((inicio, i) => ({ inicio, fim: cortes[i + 1] }));
}

/** Distribui os trechos da linha nas colunas detectadas. */
function linhaParaCelulas(linha, colunas) {
  const celulas = new Array(colunas.length).fill('');

  for (const t of linha.trechos) {
    const centro = t.x + t.largura / 2;
    let idx = colunas.findIndex((c) => centro >= c.inicio && centro < c.fim);
    if (idx === -1) idx = 0;
    celulas[idx] = celulas[idx] ? `${celulas[idx]} ${t.texto}` : t.texto;
  }

  return celulas;
}

/**
 * Converte o PDF em uma ou mais matrizes de celulas.
 * opcoes: { umaAbaPorPagina, removerCabecalhosRepetidos }
 */
async function pdfParaMatrizes(buffer, opcoes = {}) {
  const paginas = await extrairTrechos(buffer);
  if (!paginas.length) throw new Error('PDF sem páginas legíveis.');

  const linhasPorPagina = paginas.map((p) => ({
    numero: p.numero,
    linhas: agruparEmLinhas(p.trechos),
  }));

  const totalTrechos = paginas.reduce((s, p) => s + p.trechos.length, 0);
  if (totalTrechos === 0) {
    throw new Error(
      'Nenhum texto encontrado no PDF. Provavelmente é um documento digitalizado '
      + '(imagem), que exigiria OCR — não suportado por este conversor.'
    );
  }

  // A grade de colunas e calculada com todas as paginas: relatorios mantem
  // o mesmo leiaute em todas elas, e isso garante colunas alinhadas na uniao.
  const todasAsLinhas = linhasPorPagina.flatMap((p) => p.linhas);

  // Tabelas com colunas muito juntas nao produzem corredores de 5 pontos.
  // Nesse caso vamos afrouxando o criterio ate achar mais de uma coluna,
  // em vez de devolver a pagina inteira em uma celula so.
  let colunas = null;
  for (const gap of [GAP_MINIMO, 4, 3, 2]) {
    const tentativa = detectarColunas(todasAsLinhas, gap);
    if (tentativa && tentativa.length > 1) { colunas = tentativa; break; }
    if (tentativa && !colunas) colunas = tentativa;
  }
  if (!colunas) colunas = [{ inicio: -Infinity, fim: Infinity }];

  const matrizes = [];
  const vistas = new Set();

  for (const pagina of linhasPorPagina) {
    const matriz = [];
    for (const linha of pagina.linhas) {
      const celulas = linhaParaCelulas(linha, colunas);
      if (!celulas.some((c) => c !== '')) continue;

      if (!opcoes.umaAbaPorPagina && opcoes.removerCabecalhosRepetidos !== false) {
        const assinatura = celulas.join('');
        if (pagina.numero === 1) {
          vistas.add(assinatura);
        } else if (vistas.has(assinatura)) {
          continue; // cabecalho/rodape repetido nas paginas seguintes
        }
      }

      matriz.push(celulas);
    }

    matrizes.push({ nome: `Página ${pagina.numero}`, matriz });
  }

  if (opcoes.umaAbaPorPagina) return matrizes;

  const unificada = matrizes.flatMap((m) => m.matriz);
  return [{ nome: 'Dados', matriz: unificada }];
}

/* ------------------------------------------------------------------ *
 * Conversao principal
 * ------------------------------------------------------------------ */

/** Converte numeros e datas em texto para o tipo nativo da celula. */
function tipar(valor) {
  if (typeof valor !== 'string') return valor;
  const s = valor.trim();
  if (!s) return '';

  // 1.234,56 / 1234,56 / R$ 1.234,56 -> numero
  const limpo = s.replace(/^R\$\s*/i, '');
  if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(limpo) || /^-?\d+,\d+$/.test(limpo)) {
    const n = Number(limpo.replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  // Inteiro longo (matricula, CPF, codigo) fica como texto para nao perder
  // zeros a esquerda nem virar notacao cientifica no Excel.
  if (/^-?\d+$/.test(limpo)) {
    return limpo.length <= 4 && !limpo.startsWith('0') ? Number(limpo) : limpo;
  }
  return s;
}

function matrizParaAba(matriz) {
  const tipada = matriz.map((linha) => linha.map(tipar));
  const aba = XLSX.utils.aoa_to_sheet(tipada);

  // Largura de coluna aproximada pelo conteudo, limitada a 60 caracteres.
  const larguras = [];
  for (const linha of tipada) {
    linha.forEach((celula, i) => {
      const tamanho = String(celula ?? '').length;
      if (!larguras[i] || tamanho > larguras[i]) larguras[i] = tamanho;
    });
  }
  aba['!cols'] = larguras.map((w) => ({ wch: Math.min(60, Math.max(8, w + 2)) }));

  return aba;
}

/** Nome de aba valido no Excel: <=31 caracteres, sem : \ / ? * [ ] */
function nomeDeAbaValido(nome, usados) {
  let limpo = String(nome || 'Dados').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Dados';
  let final = limpo;
  let n = 2;
  while (usados.has(final)) {
    const sufixo = ` (${n++})`;
    final = limpo.slice(0, 31 - sufixo.length) + sufixo;
  }
  usados.add(final);
  return final;
}

/**
 * Converte um arquivo para .xlsx.
 * Retorna { buffer, resumo: { origem, abas: [{nome, linhas, colunas}], totalLinhas } }
 */
async function converterParaXlsx(buffer, nomeArquivo, opcoes = {}) {
  const ext = String(nomeArquivo || '').toLowerCase().split('.').pop();
  let partes;
  let origem;

  if (ext === 'pdf') {
    origem = 'PDF';
    partes = await pdfParaMatrizes(buffer, opcoes);
  } else if (ext === 'csv' || ext === 'txt') {
    origem = ext.toUpperCase();
    const matriz = lerCSV(decodificar(buffer)).filter((l) => l.some((c) => String(c).trim() !== ''));
    if (!matriz.length) throw new Error('Arquivo de texto vazio.');
    partes = [{ nome: 'Dados', matriz }];
  } else if (['xlsx', 'xls', 'xlsm', 'ods', 'fods', 'xlsb'].includes(ext)) {
    origem = ext.toUpperCase();
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    partes = wb.SheetNames.map((nome) => ({
      nome,
      matriz: XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: '', blankrows: false }),
    }));
    if (!partes.length) throw new Error('Planilha sem abas.');
  } else {
    throw new Error(`Formato não suportado: .${ext}. Aceitos: PDF, CSV, TXT, XLS, XLSX, ODS.`);
  }

  const wb = XLSX.utils.book_new();
  const usados = new Set();
  const resumoAbas = [];

  for (const parte of partes) {
    const matriz = parte.matriz.length ? parte.matriz : [['(sem conteúdo)']];
    const nome = nomeDeAbaValido(parte.nome, usados);
    XLSX.utils.book_append_sheet(wb, matrizParaAba(matriz), nome);
    resumoAbas.push({
      nome,
      linhas: parte.matriz.length,
      colunas: parte.matriz.reduce((m, l) => Math.max(m, l.length), 0),
      previa: matriz.slice(0, 30).map((l) => l.map((c) => (c === null || c === undefined ? '' : String(c)))),
    });
  }

  return {
    buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    resumo: {
      origem,
      abas: resumoAbas.map(({ previa, ...resto }) => resto),
      previas: resumoAbas.map(({ nome, previa }) => ({ nome, previa })),
      totalLinhas: resumoAbas.reduce((s, a) => s + a.linhas, 0),
    },
  };
}

module.exports = { converterParaXlsx };
