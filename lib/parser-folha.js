'use strict';

/*
 * IMPORTAÇÃO 1 — Relatório da folha (SIAFEM / PPAREL14, PDF)
 * "Classificação Orçamentária com Regime de Previdência Social"
 *
 * O documento é dividido em FOLHAS. Cada folha é um grupo (ADM/MAG x nível
 * x modalidade) e fecha com o próprio total:
 *
 *   REFERÊNCIA: 08/2026 UG: 160102 ... No FOLHA: 1  MAG-EF -REG MAGISTERIO ...
 *     3.1.90.11.01 DESPESAS CORRENTES        FONTE: 01540000043.000000
 *       0001-VENCIMENTO BASE  3.771.447,49  1.630,68  100.180,57  0,00 ...
 *       Total Líquido:  4.328.970,15  3.947.925,30  381.044,85  0,00  0,00
 *     ...
 *     TOTAL DA FOLHA = (C)            13.951.429,21
 *     LÍQUIDO DA FOLHA = (C) - (E)    12.752.031,45
 *
 * Daqui saem as três informações pedidas:
 *   1. o código da natureza da despesa  (3.1.90.11.01)
 *   2. os valores separados             (Total Líquido: total | RPPS | RGPS | Militar | Outros)
 *   3. o total                          (TOTAL DA FOLHA, por grupo, e o geral)
 *
 * A etiqueta "FONTE:" que aparece aqui NÃO é usada: a fonte válida é a da
 * Importação 2. Ela é guardada apenas como referência.
 */

const { paraCentavos } = require('./util');
const { acharGrupo, normalizar } = require('./grupos');
const { lerLinhasComPosicao } = require('./posicao-pdf');

const RE_NATUREZA = /^(\d\.\d\.\d{2}\.\d{2}\.\d{2})\s+(.*)$/;
const RE_FONTE = /FONTE:\s*([\d.]+)/;
const RE_CABECALHO_FOLHA = /No FOLHA:\s*(\d+)\s+(.*)$/;
const RE_TOTAL_LIQUIDO = /^Total L[íi]quido:\s*(.*)$/;
const RE_TOTAL_FOLHA = /TOTAL DA FOLHA\s*=\s*\(C\)\s*([\d.,-]+)/i;
const RE_LIQUIDO_FOLHA = /L[íi]QUIDO DA FOLHA\s*=\s*\(C\)\s*-\s*\(E\)\s*([\d.,-]+)/i;
const RE_COMPETENCIA = /REFER[ÊE]NCIA:\s*(\d{2}\/\d{4})/i;

/** "1.217,96 754,62 463,34 0,00 0,00" -> centavos por coluna. */
function valoresDaLinha(texto) {
  return texto.split(/\s+/).filter(Boolean).map(paraCentavos);
}

/**
 * Processa o relatório da folha.
 * Retorna { competencia, grupos, naturezas, totalCentavos, liquidoCentavos, avisos }.
 */
async function processarRelatorioFolha(buffer) {
  const paginas = await lerLinhasComPosicao(buffer);
  if (!paginas.length) throw new Error('PDF sem páginas legíveis.');

  const grupos = [];
  const naturezas = [];
  const avisos = [];
  let competencia = null;
  let rotuloAtual = '';
  let naturezaAtual = null;

  for (const pagina of paginas) {
    for (const { texto: linha } of pagina.linhas) {
      if (!competencia) {
        const c = linha.match(RE_COMPETENCIA);
        if (c) competencia = c[1];
      }

      const cab = linha.match(RE_CABECALHO_FOLHA);
      if (cab) {
        // "RECURSOS PRÓPRIOS MAG-EF -REG MAGISTERIO ENSINO FUNDAMENTAL REGULAR"
        // -> descarta os códigos curtos e fica com o nome por extenso.
        const m = cab[2].match(/[A-Z]{3}-[A-Z]{2}\s*-\s*\S+\s+(.*)$/);
        rotuloAtual = (m ? m[1] : cab[2]).trim().replace(/\s+/g, ' ');
        continue;
      }

      const nat = linha.match(RE_NATUREZA);
      if (nat) {
        naturezaAtual = {
          natureza: nat[1],
          descricao: nat[2].replace(RE_FONTE, '').trim(),
          fonteRelatorio: (linha.match(RE_FONTE) || [])[1] || null,
          rotulo: rotuloAtual,
          pagina: pagina.numero,
        };
        continue;
      }

      const totLiq = linha.match(RE_TOTAL_LIQUIDO);
      if (totLiq && naturezaAtual) {
        const v = valoresDaLinha(totLiq[1]);
        naturezas.push({
          ...naturezaAtual,
          totalCentavos: v[0] || 0,
          rppsCentavos: v[1] || 0,
          rgpsCentavos: v[2] || 0,
          militarCentavos: v[3] || 0,
          outrosCentavos: v[4] || 0,
        });
        naturezaAtual = null;
        continue;
      }

      const totFolha = linha.match(RE_TOTAL_FOLHA);
      if (totFolha) {
        const oficial = acharGrupo(rotuloAtual);
        if (!oficial) avisos.push(`Folha "${rotuloAtual}" não corresponde a nenhum grupo oficial.`);
        grupos.push({
          rotulo: rotuloAtual,
          grupo: oficial ? oficial.nome : rotuloAtual,
          chave: oficial ? oficial.chave : normalizar(rotuloAtual),
          reconhecido: Boolean(oficial),
          totalCentavos: paraCentavos(totFolha[1]),
          liquidoCentavos: 0,
          pagina: pagina.numero,
        });
        continue;
      }

      const liq = linha.match(RE_LIQUIDO_FOLHA);
      if (liq && grupos.length) {
        grupos[grupos.length - 1].liquidoCentavos = paraCentavos(liq[1]);
      }
    }
  }

  if (!grupos.length) {
    throw new Error(
      'Nenhuma folha encontrada. Esperado o relatório de Classificação Orçamentária '
      + '(PPAREL14), com linhas "TOTAL DA FOLHA = (C)".'
    );
  }

  // O mesmo grupo pode aparecer em mais de uma folha: soma.
  const porGrupo = new Map();
  for (const g of grupos) {
    const atual = porGrupo.get(g.chave);
    if (atual) {
      atual.totalCentavos += g.totalCentavos;
      atual.liquidoCentavos += g.liquidoCentavos;
      atual.folhas += 1;
    } else {
      porGrupo.set(g.chave, { ...g, folhas: 1 });
    }
  }

  const consolidados = [...porGrupo.values()];
  return {
    competencia,
    grupos: consolidados,
    naturezas,
    totalCentavos: consolidados.reduce((s, g) => s + g.totalCentavos, 0),
    liquidoCentavos: consolidados.reduce((s, g) => s + g.liquidoCentavos, 0),
    paginas: paginas.length,
    avisos: avisos.slice(0, 20),
  };
}

/** Reconhece o arquivo pelo cabeçalho do relatório. */
function ehRelatorioFolha(textoInicial) {
  return /CLASSIFICA[ÇC][ÃA]O OR[ÇC]AMENT[ÁA]RIA/i.test(textoInicial)
      || /PPAREL14/i.test(textoInicial);
}

module.exports = { processarRelatorioFolha, ehRelatorioFolha };
