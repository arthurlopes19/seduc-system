'use strict';

/*
 * Leitura de PDF preservando a posição de cada pedaço de texto.
 *
 * O PDF não guarda linhas nem colunas: guarda trechos soltos com coordenadas.
 * Aqui os trechos são agrupados por altura (Y) para formar linhas, e dentro de
 * cada linha ficam ordenados pela horizontal (X) — que é o que permite separar
 * as colunas depois.
 */

let pdfjsPromise = null;
function carregarPdfjs() {
  // pdfjs-dist é ESM; carregado sob demanda para não pesar o boot do servidor.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * Devolve [{ numero, linhas: [{ texto, pecas: [{ x, texto }] }] }].
 */
async function lerLinhasComPosicao(buffer) {
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
      const porAltura = new Map();

      for (const item of (await pagina.getTextContent()).items) {
        const texto = (item.str || '').replace(/\s+/g, ' ').trim();
        if (!texto) continue;
        const y = Math.round(item.transform[5]);
        if (!porAltura.has(y)) porAltura.set(y, []);
        porAltura.get(y).push({ x: item.transform[4], texto });
      }

      paginas.push({
        numero: n,
        linhas: [...porAltura.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, pecas]) => {
            const ordenadas = pecas.sort((a, b) => a.x - b.x);
            return { texto: ordenadas.map((p) => p.texto).join(' ').trim(), pecas: ordenadas };
          }),
      });
      pagina.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  if (!paginas.length) throw new Error('PDF sem páginas legíveis.');
  return paginas;
}

/** Texto das primeiras linhas — usado para reconhecer que documento é. */
async function primeirasLinhas(buffer, quantidade = 12) {
  const paginas = await lerLinhasComPosicao(buffer);
  return paginas[0].linhas.slice(0, quantidade).map((l) => l.texto).join('\n');
}

module.exports = { lerLinhasComPosicao, primeirasLinhas };
