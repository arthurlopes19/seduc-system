'use strict';

/* Gera uma planilha de exemplo no formato tipico da folha da SEDUC:
 * linha de titulo, linha em branco, cabecalho e uma linha de total no fim.
 * Uso: npm run exemplo  ->  data/exemplo-folha.xlsx
 */

const path = require('node:path');
const fs = require('node:fs');
const XLSX = require('xlsx');

const FONTES = [
  'Salário Educação',
  'Tesouro Estadual',
  'FUNDEB 60%',
  'FUNDEB 40%',
  'Convênio Federal',
];

const CARGOS = ['Professor I', 'Professor II', 'Agente de Organização', 'Diretor de Escola', 'Merendeira'];
const UNIDADES = ['EE Prof. Antônio Silva', 'EE Vila Nova', 'EE Central', 'EE Jardim das Flores'];
const VERBAS = ['Vencimento Base', 'Hora Extra', 'Gratificação de Função', 'Substituição', 'Adicional Noturno'];
const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elaine', 'Fábio', 'Gisele', 'Heitor', 'Isabel', 'João',
  'Karina', 'Lucas', 'Marina', 'Nelson', 'Olívia', 'Paulo', 'Renata', 'Sérgio', 'Tatiana', 'Vitor'];
const SOBRENOMES = ['Silva', 'Souza', 'Oliveira', 'Pereira', 'Costa', 'Almeida', 'Ferreira', 'Ribeiro'];

const aleatorio = (lista) => lista[Math.floor(Math.random() * lista.length)];

const linhas = [
  ['SECRETARIA DE ESTADO DA EDUCAÇÃO — FOLHA DE PAGAMENTO'],
  ['Competência: 08/2026'],
  [],
  ['Matrícula', 'Nome do Servidor', 'Cargo', 'Unidade Escolar', 'Verba', 'Competência', 'Fonte', 'Valor'],
];

let total = 0;
for (let i = 0; i < 120; i++) {
  const valor = Math.round((1500 + Math.random() * 7000) * 100) / 100;
  total += valor;
  linhas.push([
    String(100000 + i),
    `${aleatorio(NOMES)} ${aleatorio(SOBRENOMES)}`,
    aleatorio(CARGOS),
    aleatorio(UNIDADES),
    aleatorio(VERBAS),
    '08/2026',
    aleatorio(FONTES),
    valor,
  ]);
}
linhas.push([]);
linhas.push(['TOTAL GERAL', '', '', '', '', '', '', Math.round(total * 100) / 100]);

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Folha');

const destino = path.join(__dirname, '..', 'data', 'exemplo-folha.xlsx');
fs.mkdirSync(path.dirname(destino), { recursive: true });
XLSX.writeFile(wb, destino);

console.log(`Planilha de exemplo gerada: ${destino}`);
console.log(`${linhas.length - 6} linhas · total R$ ${total.toFixed(2)}`);
