'use strict';

/* Gera um PDF de exemplo no formato de relatorio da folha (tabela com
 * cabecalho repetido por pagina), para testar o conversor PDF -> Excel.
 * Uso: npm run exemplo-pdf  ->  data/exemplo-folha.pdf
 */

const path = require('node:path');
const fs = require('node:fs');
const PDFDocument = require('pdfkit');

const COLUNAS = [
  { titulo: 'Matrícula', x: 40, largura: 70 },
  { titulo: 'Nome do Servidor', x: 115, largura: 145 },
  { titulo: 'Lotação', x: 265, largura: 130 },
  { titulo: 'Fonte', x: 400, largura: 105 },
  { titulo: 'Valor', x: 505, largura: 70, direita: true },
];

const FONTES = ['Salário Educação', 'Tesouro Estadual', 'FUNDEB 60%', 'FUNDEB 40%'];
const UNIDADES = ['EE Prof. Antônio Silva', 'EE Vila Nova', 'EE Central', 'EE Jardim das Flores'];
const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elaine', 'Fábio', 'Gisele', 'Heitor', 'Isabel', 'João'];
const SOBRENOMES = ['Silva', 'Souza', 'Oliveira', 'Pereira', 'Costa', 'Almeida'];

const aleatorio = (l) => l[Math.floor(Math.random() * l.length)];
const moeda = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const destino = path.join(__dirname, '..', 'data', 'exemplo-folha.pdf');
fs.mkdirSync(path.dirname(destino), { recursive: true });

const doc = new PDFDocument({ size: 'A4', margin: 40 });
doc.pipe(fs.createWriteStream(destino));

const LINHAS_POR_PAGINA = 32;
const TOTAL = 70;
let y = 0;

function cabecalhoPagina(pagina) {
  doc.fontSize(13).font('Helvetica-Bold')
    .text('SECRETARIA DE ESTADO DA EDUCAÇÃO', 40, 40);
  doc.fontSize(10).font('Helvetica')
    .text(`Relatório de Folha de Pagamento — Competência 08/2026 — página ${pagina}`, 40, 58);

  y = 90;
  doc.fontSize(9).font('Helvetica-Bold');
  for (const c of COLUNAS) {
    doc.text(c.titulo, c.x, y, { width: c.largura, align: c.direita ? 'right' : 'left' });
  }
  y += 14;
  doc.moveTo(40, y).lineTo(575, y).stroke();
  y += 6;
  doc.font('Helvetica');
}

let total = 0;
let pagina = 1;
cabecalhoPagina(pagina);

for (let i = 0; i < TOTAL; i++) {
  if (i > 0 && i % LINHAS_POR_PAGINA === 0) {
    doc.addPage();
    pagina++;
    cabecalhoPagina(pagina);
  }

  const valor = Math.round((1500 + Math.random() * 7000) * 100) / 100;
  total += valor;

  const celulas = [
    String(300000 + i),
    `${aleatorio(NOMES)} ${aleatorio(SOBRENOMES)}`,
    aleatorio(UNIDADES),
    aleatorio(FONTES),
    moeda(valor),
  ];

  doc.fontSize(9);
  COLUNAS.forEach((c, idx) => {
    doc.text(celulas[idx], c.x, y, { width: c.largura, align: c.direita ? 'right' : 'left', lineBreak: false });
  });
  y += 15;
}

y += 8;
doc.moveTo(40, y).lineTo(575, y).stroke();
y += 6;
doc.font('Helvetica-Bold').fontSize(9);
doc.text('TOTAL GERAL', COLUNAS[0].x, y);
doc.text(moeda(total), COLUNAS[4].x, y, { width: COLUNAS[4].largura, align: 'right' });

doc.end();
console.log(`PDF de exemplo gerado: ${destino} (${TOTAL} linhas, ${pagina} páginas)`);
