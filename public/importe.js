/* ------------------------------------------------------------------
   SEDUC · Aba Importe — duas importações e a base consolidada
   Depende de app.js (helpers $, $$, fmt, avisar, api).
   ------------------------------------------------------------------ */
'use strict';

const imp = {
  arquivos: { folha: null, empenho: null },
  consolidado: null,
  naturezas: null,
  filtro: 'todos',
  buscaNatureza: '',
};

/* ---------------- navegação entre as views ---------------- */

function trocarView(nome) {
  document.querySelectorAll('#nav-principal button').forEach((b) => {
    b.classList.toggle('ativo', b.dataset.view === nome);
  });
  $('#view-empenho').hidden = nome !== 'empenho';
  $('#view-importe').hidden = nome !== 'importe';
  // O botão de importar planilha pertence ao fluxo de empenho.
  $('#btn-abrir-upload').hidden = nome !== 'empenho';
  if (nome === 'importe') carregarConsolidado();
}

document.querySelectorAll('#nav-principal button').forEach((b) => {
  b.onclick = () => trocarView(b.dataset.view);
});

/* ---------------- seleção de arquivo ---------------- */

/** Liga uma área de drop a um tipo de importação. */
function ligarDrop(tipo) {
  const area = $(`#drop-${tipo}`);
  const input = $(`#arq-${tipo}`);

  const definir = (arquivo) => {
    imp.arquivos[tipo] = arquivo;
    $(`#nome-${tipo}`).textContent = arquivo
      ? `${arquivo.name} (${(arquivo.size / 1024).toFixed(0)} KB)`
      : '';
    $(`#btn-enviar-${tipo}`).disabled = !arquivo;
  };

  area.onclick = () => input.click();
  input.onchange = (e) => definir(e.target.files[0]);

  ['dragover', 'dragenter'].forEach((ev) =>
    area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('sobre'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    area.addEventListener(ev, () => area.classList.remove('sobre')));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) definir(e.dataTransfer.files[0]);
  });
}

ligarDrop('folha');
ligarDrop('empenho');

/* ---------------- envio ---------------- */

async function enviarImporte(tipo) {
  const arquivo = imp.arquivos[tipo];
  if (!arquivo) return;

  const botao = $(`#btn-enviar-${tipo}`);
  const retorno = $('#importe-retorno');
  botao.disabled = true;
  botao.textContent = 'Processando…';
  retorno.hidden = true;

  try {
    const dados = new FormData();
    dados.append('arquivo', arquivo);
    const resposta = await fetch(`/api/importe/${tipo}`, { method: 'POST', body: dados });
    const json = await resposta.json();
    if (!resposta.ok) throw new Error(json.erro || 'Falha na importação.');

    avisar(
      tipo === 'folha'
        ? `Relatório lido: ${json.grupos} grupos em ${json.paginas} páginas.`
        : `Empenho lido: ${json.itens} itens em ${json.grupos} grupos.`,
      'ok'
    );
    imp.arquivos[tipo] = null;
    $(`#nome-${tipo}`).textContent = '';
    $(`#arq-${tipo}`).value = '';
    await carregarConsolidado();
  } catch (e) {
    retorno.className = 'retorno erro';
    retorno.textContent = e.message;
    retorno.hidden = false;
  } finally {
    botao.disabled = !imp.arquivos[tipo];
    botao.textContent = 'Importar';
  }
}

$('#btn-enviar-folha').onclick = () => enviarImporte('folha');
$('#btn-enviar-empenho').onclick = () => enviarImporte('empenho');

const removerImporte = async (tipo) => {
  if (!confirm(`Remover a ${tipo === 'folha' ? 'Importação 1' : 'Importação 2'}?`)) return;
  await api(`/api/importe/${tipo}`, { method: 'DELETE' });
  await carregarConsolidado();
  avisar('Importação removida.', 'ok');
};
$('#btn-limpar-folha').onclick = () => removerImporte('folha');
$('#btn-limpar-empenho').onclick = () => removerImporte('empenho');

/* ---------------- consolidação ---------------- */

async function carregarConsolidado() {
  const [consolidado, naturezas] = await Promise.all([
    api('/api/importe/consolidado'),
    api('/api/importe/naturezas'),
  ]);
  imp.consolidado = consolidado;
  imp.naturezas = naturezas;
  renderStatus();
  renderConsolidado();
}

/** Cartão de cada importação: o que já foi carregado. */
function renderStatus() {
  const { folha, empenho } = imp.consolidado.importacoes;

  const pintar = (tipo, dados, descricao) => {
    const caixa = $(`#status-${tipo}`);
    $(`#btn-limpar-${tipo}`).hidden = !dados;
    $(`#card-${tipo}`).classList.toggle('carregado', Boolean(dados));
    if (!dados) { caixa.hidden = true; return; }
    caixa.innerHTML = '';
    const nome = document.createElement('b');
    nome.textContent = dados.nomeArquivo;
    const meta = document.createElement('span');
    meta.textContent = descricao(dados);
    caixa.append(nome, meta);
    caixa.hidden = false;
  };

  pintar('folha', folha, (d) =>
    `${d.competencia || '—'} · ${d.itens} naturezas · total ${fmt(d.totalCentavos)} · ${d.enviadoEm}`);
  pintar('empenho', empenho, (d) =>
    `${d.competencia || '—'} · ${d.origem} · ${d.itens} itens · total ${fmt(d.totalCentavos)} · ${d.enviadoEm}`);
}

function renderConsolidado() {
  const dados = imp.consolidado;
  const temAlgo = dados.importacoes.folha || dados.importacoes.empenho;

  $('#importe-vazio').hidden = Boolean(temAlgo);
  $('#consolidado').hidden = !temAlgo;
  if (!temAlgo) return;

  const t = dados.totais;
  $('#cons-empenho').textContent = fmt(t.empenhoCentavos);
  $('#cons-folha').textContent = fmt(t.folhaCentavos);

  const dif = $('#cons-diferenca');
  dif.textContent = fmt(t.diferencaCentavos);
  dif.className = 'cartao-valor ' + (t.diferencaCentavos === 0 ? 'cor-saldo' : 'cor-negativo');
  $('#cons-diferenca-nota').textContent = t.diferencaCentavos === 0
    ? 'os dois documentos fecham'
    : `${t.gruposComDiferenca} grupo(s) não fecham`;

  $('#cons-sub').textContent =
    `${dados.grupos.length} grupos oficiais · ${t.gruposConferem} conferem · `
    + `${t.gruposComDiferenca} com diferença · ${t.gruposSemMovimento} sem movimento`;

  renderTabelaGrupos();
  renderNaturezas();
  renderFontes();
}

/*
 * Naturezas de despesa da Importação 1 — os códigos no formato 3.1.90.11.06,
 * com os valores separados por regime e o total de cada um.
 */
function renderNaturezas() {
  const dados = imp.naturezas;
  const painel = $('#painel-naturezas');
  painel.hidden = !dados || !dados.naturezas.length;
  if (painel.hidden) return;

  const termo = imp.buscaNatureza.trim().toLowerCase();
  const lista = termo
    ? dados.naturezas.filter((n) =>
        n.natureza.toLowerCase().includes(termo)
        || String(n.descricao || '').toLowerCase().includes(termo)
        || n.codigoEmpenho.includes(termo))
    : dados.naturezas;

  $('#nat-sub').textContent =
    `${dados.naturezas.length} códigos no relatório · total ${fmt(dados.totalCentavos)}`
    + (termo ? ` · ${lista.length} no filtro` : '');

  const corpo = $('#nat-corpo');
  corpo.innerHTML = '';

  for (const n of lista) {
    const tr = document.createElement('tr');
    const td = (texto, classe) => {
      const c = document.createElement('td');
      c.textContent = texto;
      if (classe) c.className = classe;
      return c;
    };
    const descricao = td(n.descricao || '—');
    if (n.descricoes > 1) descricao.title = `${n.descricoes} descrições diferentes no relatório`;

    tr.append(
      td(n.natureza, 'col-codigo'),
      descricao,
      td(n.codigoEmpenho, 'col-codigo secundario'),
      td(fmt(n.rppsCentavos), 'valor'),
      td(fmt(n.rgpsCentavos), 'valor'),
      td(fmt(n.militarCentavos), 'valor'),
      td(fmt(n.outrosCentavos), 'valor'),
      td(fmt(n.totalCentavos), 'valor')
    );
    corpo.appendChild(tr);
  }

  // rodapé com a soma do que está sendo mostrado
  const rodape = $('#nat-rodape');
  rodape.innerHTML = '';
  const somar = (campo) => lista.reduce((s, n) => s + n[campo], 0);
  const tr = document.createElement('tr');
  const rotulo = document.createElement('td');
  rotulo.colSpan = 3;
  rotulo.textContent = termo ? 'Total do filtro' : 'Total';
  tr.appendChild(rotulo);
  for (const campo of ['rppsCentavos', 'rgpsCentavos', 'militarCentavos', 'outrosCentavos', 'totalCentavos']) {
    const td = document.createElement('td');
    td.className = 'valor';
    td.textContent = fmt(somar(campo));
    tr.appendChild(td);
  }
  rodape.appendChild(tr);
}

const CLASSE_SITUACAO = {
  'confere': 'ok',
  'sem movimento': 'neutro',
  'não saiu na folha': 'erro',
  'fora do empenho': 'erro',
  'saiu a menor': 'alerta',
  'saiu a maior': 'alerta',
};

function renderTabelaGrupos() {
  const corpo = $('#cons-corpo');
  corpo.innerHTML = '';

  const lista = imp.consolidado.grupos.filter((g) => {
    if (imp.filtro === 'diferenca') return g.diferencaCentavos !== 0;
    if (imp.filtro === 'movimento') return g.empenhoCentavos !== 0 || g.folhaCentavos !== 0;
    return true;
  });

  for (const g of lista) {
    const tr = document.createElement('tr');
    if (g.diferencaCentavos !== 0) tr.className = 'linha-diferenca';

    const tdGrupo = document.createElement('td');
    tdGrupo.textContent = g.grupo;

    const valor = (centavos, destacar) => {
      const td = document.createElement('td');
      td.className = 'valor';
      td.textContent = fmt(centavos);
      if (destacar && centavos !== 0) td.classList.add('cor-negativo');
      return td;
    };

    const tdSit = document.createElement('td');
    const etiqueta = document.createElement('span');
    etiqueta.className = `etiqueta ${CLASSE_SITUACAO[g.situacao] || ''}`;
    etiqueta.textContent = g.situacao;
    tdSit.appendChild(etiqueta);

    tr.append(
      tdGrupo,
      valor(g.empenhoCentavos),
      valor(g.folhaCentavos),
      valor(g.diferencaCentavos, true),
      tdSit
    );
    corpo.appendChild(tr);
  }
}

function renderFontes() {
  const fontes = imp.consolidado.fontes;
  $('#painel-fontes').hidden = fontes.length === 0;
  const corpo = $('#fontes-corpo');
  corpo.innerHTML = '';

  for (const f of fontes) {
    const tr = document.createElement('tr');
    const td = (texto, classe) => {
      const c = document.createElement('td');
      c.textContent = texto;
      if (classe) c.className = classe;
      return c;
    };
    const saldo = td(fmt(f.saldoCentavos), 'valor');
    if (f.saldoCentavos < 0) saldo.classList.add('cor-negativo');
    else if (f.saldoCentavos > 0) saldo.classList.add('cor-saldo');

    tr.append(
      td(f.codigo, 'col-codigo'),
      td(f.titulo),
      td(fmt(f.folhaCentavos), 'valor'),
      td(fmt(f.receitaCentavos), 'valor'),
      saldo
    );
    corpo.appendChild(tr);
  }
}

$$('#filtro-cons button').forEach((b) => {
  b.onclick = () => {
    $$('#filtro-cons button').forEach((x) => x.classList.remove('ativo'));
    b.classList.add('ativo');
    imp.filtro = b.dataset.filtro;
    renderTabelaGrupos();
  };
});

let timerNatureza;
$('#busca-natureza').oninput = (e) => {
  clearTimeout(timerNatureza);
  const valor = e.target.value;
  timerNatureza = setTimeout(() => { imp.buscaNatureza = valor; renderNaturezas(); }, 200);
};
