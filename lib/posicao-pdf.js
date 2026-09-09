'use strict';

/*
 * Leitura de PDF preservando a posição de cada pedaço de texto.
 *
 * O PDF não guarda linhas nem colunas: guarda trechos soltos com coordenadas.
 * Aqui os trechos são agrupados por altura (Y) para formar linhas, e dentro de
 * cada linha ficam ordenados pela horizontal (X) — que é o que permite separar
 * as colunas depois.
 */

const { pathToFileURL } = require('node:url');

let pdfjsPromise = null;
function carregarPdfjs() {
  // pdfjs-dist é ESM; carregado sob demanda para não pesar o boot do servidor.
  if (pdfjsPromise) return pdfjsPromise;

  pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    /*
     * Sem isso, em serverless, a leitura falha com "Setting up fake worker
     * failed": a biblioteca procura o worker por um import dinâmico que o
     * empacotador da Vercel não enxerga, e o arquivo não sobe junto. Apontar
     * o caminho resolvido — junto com o includeFiles do vercel.json — faz o
     * worker ser encontrado.
     */
    try {
      // pathToFileURL porque o carregador ESM recusa caminho absoluto do
      // Windows ("C:\...") — precisa ser file://.
      const caminho = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(caminho).href;
    } catch {
      // Ambiente sem o arquivo: a leitura segue na própria thread.
    }
    return pdfjs;
  });

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
