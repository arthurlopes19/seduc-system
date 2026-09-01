/* ------------------------------------------------------------------
   SEDUC · Mapeamento manual de colunas

   Entra em cena quando o reconhecimento automático falha: mostra o que o
   sistema realmente leu do arquivo e deixa a operadora apontar qual linha
   é o cabeçalho e onde estão Fonte e Valor.
   ------------------------------------------------------------------ */
'use strict';

const CAMPOS_MAPA = [
  { chave: 'fonte', rotulo: 'Fonte', obrigatorio: true, pistas: ['FONTE', 'RECURSO'] },
  { chave: 'valor', rotulo: 'Valor', obrigatorio: true, pistas: ['VALOR', 'VLR', 'LIQUIDO', 'TOTAL'] },
  { chave: 'nome', rotulo: 'Nome do servidor', pistas: ['NOME', 'SERVIDOR', 'BENEFICIARIO', 'FUNCIONARIO'] },
  { chave: 'matricula', rotulo: 'Matrícula', pistas: ['MATRIC', 'CADASTRO', 'CPF', 'ID'] },
  { chave: 'cargo', rotulo: 'Cargo', pistas: ['CARGO', 'FUNCAO'] },
  { chave: 'lotacao', rotulo: 'Lotação', pistas: ['LOTAC', 'UNIDADE', 'ESCOLA', 'SETOR'] },
  { chave: 'descricao', rotulo: 'Descrição / Verba', pistas: ['DESCRI', 'VERBA', 'RUBRICA', 'EVENTO'] },
  { chave: 'competencia', rotulo: 'Competência', pistas: ['COMPET', 'REFERENC', 'PERIODO', 'MES'] },
];

const mapa = {
  amostra: [],
  linhaCabecalho: 0,
  aoConfirmar: null,
};

const semAcento = (v) => String(v || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

/**
 * Abre o modal.
 * @param {string[][]} amostra  primeiras linhas lidas do arquivo
 * @param {(mapeamento) => Promise} aoConfirmar  recebe { indiceLinha, mapa }
 */
function abrirMapeamento(amostra, aoConfirmar) {
  mapa.amostra = Array.isArray(amostra) ? amostra : [];
  mapa.aoConfirmar = aoConfirmar;
  mapa.linhaCabecalho = melhorPalpiteDeCabecalho(mapa.amostra);

  $('#mapa-retorno').hidden = true;
  renderAmostraMapa();
  renderCamposMapa();
  $('#modal-mapa').showModal();
}

/** Palpite: a primeira linha com mais células preenchidas (mín. 2). */
function melhorPalpiteDeCabecalho(amostra) {
  let melhor = 0;
  let melhorQtd = 0;
  amostra.slice(0, 15).forEach((linha, i) => {
    const qtd = linha.filter((c) => String(c).trim() !== '').length;
    if (qtd > melhorQtd && qtd >= 2) { melhorQtd = qtd; melhor = i; }
  });
  return melhor;
}

function renderAmostraMapa() {
  const corpo = $('#mapa-amostra');
  corpo.innerHTML = '';
  const colunas = mapa.amostra.reduce((m, l) => Math.max(m, l.length), 0);

  mapa.amostra.forEach((linha, i) => {
    const tr = document.createElement('tr');
    tr.className = i === mapa.linhaCabecalho ? 'cabecalho' : '';
    tr.onclick = () => {
      mapa.linhaCabecalho = i;
      renderAmostraMapa();
      renderCamposMapa();
    };

    const tdNum = document.createElement('td');
    tdNum.className = 'num-linha';
    tdNum.textContent = i + 1;
    tr.appendChild(tdNum);

    for (let c = 0; c < colunas; c++) {
      const td = document.createElement('td');
      td.textContent = linha[c] || '';
      tr.appendChild(td);
    }
    corpo.appendChild(tr);
  });
}

/** Rótulo de cada coluna: título do cabeçalho escolhido + exemplo de dado. */
function rotulosDasColunas() {
  const cabecalho = mapa.amostra[mapa.linhaCabecalho] || [];
  const colunas = mapa.amostra.reduce((m, l) => Math.max(m, l.length), 0);
  const exemplo = mapa.amostra[mapa.linhaCabecalho + 1] || [];

  return Array.from({ length: colunas }, (_, c) => {
    const titulo = String(cabecalho[c] || '').trim();
    const dado = String(exemplo[c] || '').trim();
    const texto = titulo || (dado ? `ex.: ${dado}` : '(vazia)');
    return `Col ${c + 1} — ${texto.length > 34 ? `${texto.slice(0, 34)}…` : texto}`;
  });
}

/**
 * Última coluna cujas células de dados parecem valores monetários
 * (1.234,56 · R$ 1.234,56 · 1234.56). Usada quando o título não ajuda.
 */
function colunaComCaraDeDinheiro() {
  const dados = mapa.amostra.slice(mapa.linhaCabecalho + 1, mapa.linhaCabecalho + 11);
  if (!dados.length) return -1;

  const colunas = mapa.amostra.reduce((m, l) => Math.max(m, l.length), 0);
  const ehDinheiro = (v) => /^-?\s*(R\$\s*)?\d{1,3}([.\s]\d{3})*([.,]\d{2})\s*$/.test(String(v).trim());

  let escolhida = -1;
  for (let c = 0; c < colunas; c++) {
    const preenchidas = dados.filter((l) => String(l[c] || '').trim() !== '');
    if (preenchidas.length < Math.max(1, Math.floor(dados.length / 2))) continue;
    const acertos = preenchidas.filter((l) => ehDinheiro(l[c])).length;
    if (acertos / preenchidas.length >= 0.7) escolhida = c; // fica com a mais à direita
  }
  return escolhida;
}

function renderCamposMapa() {
  const container = $('#mapa-campos');
  container.innerHTML = '';

  const rotulos = rotulosDasColunas();
  const cabecalho = (mapa.amostra[mapa.linhaCabecalho] || []).map(semAcento);

  for (const campo of CAMPOS_MAPA) {
    const bloco = document.createElement('label');
    bloco.className = 'mapa-campo';

    const rotulo = document.createElement('span');
    rotulo.textContent = campo.rotulo;
    if (campo.obrigatorio) rotulo.className = 'obrigatorio';

    const select = document.createElement('select');
    select.dataset.campo = campo.chave;

    const vazio = document.createElement('option');
    vazio.value = '';
    vazio.textContent = campo.obrigatorio ? '— selecione —' : '(não usar)';
    select.appendChild(vazio);

    rotulos.forEach((texto, i) => {
      const op = document.createElement('option');
      op.value = String(i);
      op.textContent = texto;
      select.appendChild(op);
    });

    // Pré-seleção: procura no cabeçalho um título que contenha alguma pista.
    let palpite = cabecalho.findIndex((t) => t && campo.pistas.some((p) => t.includes(p)));

    // Cabeçalhos abreviados ("FR", "Vl.") não batem por pista; para o Valor
    // vale mais olhar o dado: a coluna com cara de dinheiro é a candidata.
    if (palpite < 0 && campo.chave === 'valor') palpite = colunaComCaraDeDinheiro();

    if (palpite >= 0) select.value = String(palpite);

    bloco.append(rotulo, select);
    container.appendChild(bloco);
  }
}

$('#mapa-cancelar').onclick = () => $('#modal-mapa').close();

$('#mapa-confirmar').onclick = async () => {
  const escolhas = {};
  document.querySelectorAll('#mapa-campos select').forEach((s) => {
    if (s.value !== '') escolhas[s.dataset.campo] = Number(s.value);
  });

  const retorno = $('#mapa-retorno');
  if (escolhas.fonte === undefined || escolhas.valor === undefined) {
    retorno.className = 'retorno erro';
    retorno.textContent = 'Selecione ao menos as colunas de Fonte e de Valor.';
    retorno.hidden = false;
    return;
  }
  if (escolhas.fonte === escolhas.valor) {
    retorno.className = 'retorno erro';
    retorno.textContent = 'Fonte e Valor não podem ser a mesma coluna.';
    retorno.hidden = false;
    return;
  }

  const botao = $('#mapa-confirmar');
  botao.disabled = true;
  botao.textContent = 'Importando…';

  try {
    await mapa.aoConfirmar({ indiceLinha: mapa.linhaCabecalho, mapa: escolhas });
    $('#modal-mapa').close();
  } catch (e) {
    retorno.className = 'retorno erro';
    retorno.textContent = e.message;
    retorno.hidden = false;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Importar com este mapeamento';
  }
};
