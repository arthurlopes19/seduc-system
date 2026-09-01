'use strict';

/** Remove acentos, pontuacao repetida e normaliza para comparacao de cabecalhos. */
function normalizarTexto(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const PREPOSICOES = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'NO', 'NA']);

/**
 * Chave de comparacao de cabecalho: so letras e numeros, sem preposicoes.
 * "Nome do Servidor" -> "NOMESERVIDOR"; "Fonte de Recurso" -> "FONTERECURSO".
 */
function chaveCabecalho(v) {
  return normalizarTexto(v)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t && !PREPOSICOES.has(t))
    .join('');
}

/**
 * Converte qualquer representacao de dinheiro para CENTAVOS (inteiro).
 * Aceita numero do XLSX, "R$ 1.234,56", "1234,56", "1,234.56", "(500,00)".
 */
function paraCentavos(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;

  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return 0;
    return Math.round(valor * 100);
  }

  let s = String(valor).trim();
  if (!s) return 0;

  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1); }

  s = s.replace(/r\$/gi, '').replace(/\s/g, '').replace(/[^\d,.\-]/g, '');
  if (s.startsWith('-')) { negativo = true; s = s.slice(1); }
  s = s.replace(/-/g, '');
  if (!s) return 0;

  const temPonto = s.includes('.');
  const temVirgula = s.includes(',');

  if (temPonto && temVirgula) {
    // O separador decimal e o que aparece por ultimo.
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const milhar = decimal === ',' ? '.' : ',';
    s = s.split(milhar).join('');
    s = s.replace(decimal, '.');
  } else if (temVirgula) {
    s = s.replace(/,/g, '.');
  } else if (temPonto) {
    // "1.234" = milhar | "1234.56" = decimal
    const partes = s.split('.');
    const ultima = partes[partes.length - 1];
    if (partes.length > 2 || ultima.length === 3) s = partes.join('');
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) * (negativo ? -1 : 1);
}

/** Centavos -> numero em reais (para JSON). */
function paraReais(centavos) {
  return Math.round(Number(centavos) || 0) / 100;
}

/** Formata centavos como moeda BR (usado no export CSV). */
function formatarBRL(centavos) {
  return paraReais(centavos).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

module.exports = { normalizarTexto, chaveCabecalho, paraCentavos, paraReais, formatarBRL };
