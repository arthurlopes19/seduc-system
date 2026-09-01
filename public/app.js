/* ------------------------------------------------------------------
   SEDUC · Controle de Empenho — camada de interface
   ------------------------------------------------------------------ */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const estado = {
  fontes: [],
  fonteAtiva: null,
  formato: 'folha',   // 'orcamento' (planilha padrão) | 'folha' (planilha plana)
  colunas: null,      // definição de colunas vinda da API
  linhas: [],
  selecionados: new Set(),
  filtro: { busca: '', status: 'todos' },
};

/* ---------------- utilitários ---------------- */

/** Fonte-balde: linhas cuja coluna Fonte não trazia uma fonte de verdade. */
const FONTE_NAO_IDENTIFICADA = 'Não identificada';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const numeroBR = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (centavos) => brl.format((Number(centavos) || 0) / 100);

/** "1.234,56" | "1234.56" | "R$ 1.234,56" -> centavos */
function paraCentavos(texto) {
  if (texto === null || texto === undefined) return 0;
  let s = String(texto).trim().replace(/r\$/gi, '').replace(/\s/g, '');
  if (!s) return 0;
  const temPonto = s.includes('.');
  const temVirgula = s.includes(',');
  if (temPonto && temVirgula) {
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    s = s.split(decimal === ',' ? '.' : ',').join('').replace(decimal, '.');
  } else if (temVirgula) {
    s = s.replace(/,/g, '.');
  } else if (temPonto) {
    const partes = s.split('.');
    if (partes.length > 2 || partes[partes.length - 1].length === 3) s = partes.join('');
  }
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function avisar(mensagem, tipo = '') {
  const el = document.createElement('div');
  el.className = `aviso ${tipo}`;
  el.textContent = mensagem;
  $('#avisos').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(url, opcoes = {}) {
  const resposta = await fetch(url, {
    headers: opcoes.body ? { 'Content-Type': 'application/json' } : {},
    ...opcoes,
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw Object.assign(new Error(dados.mensagem || dados.erro || 'Falha na requisição'), { dados, status: resposta.status });
  return dados;
}

/* ---------------- carga inicial ---------------- */

async function carregarFontes(manterAtiva = true) {
  const [fontes, resumo] = await Promise.all([api('/api/fontes'), api('/api/resumo')]);
  estado.fontes = fontes;

  renderResumo(resumo);
  renderAbas();
  renderManutencao();

  const temDados = fontes.some((f) => f.totalItens > 0) || fontes.length > 0;
  $('#estado-vazio').hidden = temDados;
  $('#painel').hidden = !temDados;

  if (!fontes.length) { estado.fonteAtiva = null; return; }

  const aindaExiste = manterAtiva && fontes.some((f) => f.id === estado.fonteAtiva);
  await selecionarFonte(aindaExiste ? estado.fonteAtiva : fontes[0].id);
}

function renderResumo(r) {
  $('#resumo-teto').textContent = fmt(r.tetoCentavos);
  $('#resumo-empenhado').textContent = fmt(r.empenhadoCentavos);
  $('#resumo-saldo').textContent = fmt(r.saldoCentavos);
  $('#resumo-saldo').classList.toggle('cor-negativo', r.saldoCentavos < 0);
  $('#resumo-saldo').classList.toggle('cor-saldo', r.saldoCentavos >= 0);
  $('#resumo-pendente').textContent = fmt(r.pendenteCentavos);
  $('#resumo-itens').textContent = `${r.itensEmpenhados} de ${r.itens} itens empenhados`;
}

/**
 * Fontes sem nenhum item e sem teto definido são resíduo de importação
 * (ou de arquivos já excluídos). Oferece a remoção em um clique.
 */
function renderManutencao() {
  const vazias = estado.fontes.filter((f) => f.totalItens === 0 && f.tetoCentavos === 0);
  $('#manutencao').hidden = vazias.length === 0;
  if (!vazias.length) return;
  $('#manutencao-texto').textContent =
    `${vazias.length} fonte(s) sem itens e sem teto definido.`;
}

function renderAbas() {
  const abas = $('#abas');
  abas.innerHTML = '';
  for (const f of estado.fontes) {
    const btn = document.createElement('button');
    btn.className = 'aba'
      + (f.id === estado.fonteAtiva ? ' ativa' : '')
      + (f.nome === FONTE_NAO_IDENTIFICADA ? ' alerta' : '');
    btn.setAttribute('role', 'tab');
    btn.onclick = () => selecionarFonte(f.id);

    const nome = document.createElement('span');
    nome.className = 'aba-titulo';
    nome.textContent = f.titulo || f.nome;
    if (f.codigo) nome.title = `Fonte ${f.codigo}`;

    const pastilha = document.createElement('span');
    pastilha.className = 'pastilha'
      + (f.estourouTeto ? ' estouro' : (f.totalItens && f.itensEmpenhados === f.totalItens ? ' ok' : ''));
    pastilha.textContent = `${f.itensEmpenhados}/${f.totalItens}`;

    btn.append(nome, pastilha);
    if (f.codigo) {
      const codigo = document.createElement('span');
      codigo.className = 'aba-codigo';
      codigo.textContent = f.codigo;
      btn.prepend(codigo);
    }
    abas.appendChild(btn);
  }
}

/* ---------------- painel da fonte ---------------- */

async function selecionarFonte(id) {
  estado.fonteAtiva = Number(id);
  estado.selecionados.clear();
  renderAbas();
  await carregarLinhas();
}

async function carregarLinhas() {
  const id = estado.fonteAtiva;
  if (!id) return;

  const params = new URLSearchParams();
  if (estado.filtro.status !== 'todos') params.set('status', estado.filtro.status);
  if (estado.filtro.busca) params.set('busca', estado.filtro.busca);

  const dados = await api(`/api/fontes/${id}/linhas?${params}`);
  estado.linhas = dados.linhas;
  estado.formato = dados.formato || 'folha';
  estado.colunas = dados.colunas || null;
  atualizarFonteLocal(dados.fonte);
  renderPainel(dados.fonte);
  renderTabela();
}

/** Substitui a fonte no estado (após empenho/teto) e atualiza abas + resumo. */
function atualizarFonteLocal(fonte) {
  if (!fonte) return;
  const i = estado.fontes.findIndex((f) => f.id === fonte.id);
  if (i >= 0) estado.fontes[i] = fonte;
  renderAbas();
  renderManutencao();
  api('/api/resumo').then(renderResumo).catch(() => {});
}

function renderPainel(f) {
  if (!f) return;
  $('#fonte-nome').textContent = f.codigo ? `${f.codigo} — ${f.titulo || f.nome}` : f.nome;
  $('#fonte-sub').textContent = f.nome === FONTE_NAO_IDENTIFICADA
    ? `${f.totalItens} linha(s) cuja coluna Fonte não trazia uma fonte válida `
      + '(rodapé de página, linha de total, valor solto). Revise antes de empenhar.'
    : `${f.totalItens} ${f.totalItens === 1 ? 'item importado' : 'itens importados'} · `
      + `${f.itensEmpenhados} empenhado(s)`
      + (f.metaCentavos ? ` · meta da planilha: ${fmt(f.metaCentavos)}` : '');

  const inputTeto = $('#input-teto');
  if (document.activeElement !== inputTeto) {
    inputTeto.value = f.tetoCentavos ? numeroBR.format(f.tetoCentavos / 100) : '';
  }
  $('#btn-exportar').href = `/api/fontes/${f.id}/export.csv`;

  $('#m-total').textContent = fmt(f.totalCentavos);
  $('#m-empenhado').textContent = fmt(f.empenhadoCentavos);
  $('#m-pendente').textContent = fmt(f.pendenteCentavos);
  $('#m-saldo').textContent = f.tetoCentavos ? fmt(f.saldoCentavos) : '—';
  $('#m-saldo').classList.toggle('cor-negativo', f.saldoCentavos < 0);
  $('#m-saldo').classList.toggle('cor-saldo', f.saldoCentavos >= 0);

  const pct = f.tetoCentavos > 0
    ? Math.min(100, (f.empenhadoCentavos / f.tetoCentavos) * 100)
    : 0;
  const barra = $('#medidor-preenchido');
  barra.style.width = `${pct}%`;
  barra.className = f.estourouTeto ? 'estouro' : (pct >= 90 ? 'atencao' : '');
  $('#medidor-empenhado').textContent = fmt(f.empenhadoCentavos);
  $('#medidor-saldo').textContent = f.tetoCentavos ? fmt(f.saldoCentavos) : 'teto não definido';
}

/*
 * A tabela é montada a partir de uma definição de colunas, porque os dois
 * formatos de planilha têm colunas diferentes:
 *
 *   orcamento -> Grupo · Código · Ação/Despesa · Ação · Valor · Plano Interno · Fonte
 *   folha     -> Servidor · Matrícula · Lotação · Descrição · Valor
 *
 * No formato orçamentário a ordem vem do servidor (`colunas`), que é quem
 * garante o contrato — inclusive a Fonte como última coluna.
 */
const ESTILO_COLUNA = {
  grupo: { classe: 'col-grupo secundario' },
  codigo: { classe: 'col-codigo' },
  acaoDespesa: { classe: 'col-larga' },
  acao: { classe: 'secundario' },
  valor: { classe: 'valor', tipo: 'moeda' },
  planoInterno: { classe: 'col-codigo secundario' },
  fonte: { classe: 'col-codigo secundario' },
};

const COLUNAS_FOLHA = [
  { chave: 'nome', rotulo: 'Servidor', tipo: 'servidor' },
  { chave: 'matricula', rotulo: 'Matrícula', classe: 'secundario' },
  { chave: 'lotacao', rotulo: 'Lotação' },
  { chave: 'descricao', rotulo: 'Descrição', classe: 'secundario' },
  { chave: 'valor', rotulo: 'Valor', classe: 'valor', tipo: 'moeda' },
];

function colunasAtuais() {
  if (estado.formato !== 'orcamento') return COLUNAS_FOLHA;
  const definicao = estado.colunas || Object.keys(ESTILO_COLUNA).map((chave) => ({ chave, rotulo: chave }));
  return definicao.map((c) => ({ ...c, ...(ESTILO_COLUNA[c.chave] || {}) }));
}

function renderCabecalhoTabela(colunas) {
  const cabecalho = $('#cabecalho-tabela');
  cabecalho.innerHTML = '';

  const tr = document.createElement('tr');

  const thSel = document.createElement('th');
  thSel.className = 'col-check';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.id = 'check-todos';
  check.title = 'Selecionar todos';
  check.onchange = alternarSelecaoTotal;
  thSel.appendChild(check);
  tr.appendChild(thSel);

  for (const c of colunas) {
    const th = document.createElement('th');
    th.textContent = c.rotulo;
    if (c.tipo === 'moeda') th.className = 'col-valor';
    tr.appendChild(th);
  }

  const thStatus = document.createElement('th');
  thStatus.className = 'col-status';
  thStatus.textContent = 'Empenho';
  tr.appendChild(thStatus);

  cabecalho.appendChild(tr);
}

/** Célula de uma coluna, já formatada conforme o tipo. */
function montarCelula(linha, coluna) {
  const td = document.createElement('td');
  if (coluna.classe) td.className = coluna.classe;

  if (coluna.tipo === 'moeda') {
    td.textContent = fmt(linha.valorCentavos);
    return td;
  }

  if (coluna.tipo === 'servidor') {
    const principal = document.createElement('div');
    principal.className = 'servidor';
    principal.textContent = linha.nome || '(sem nome)';
    const apoio = document.createElement('div');
    apoio.className = 'secundario';
    apoio.textContent = [linha.cargo, linha.competencia].filter(Boolean).join(' · ');
    td.append(principal, apoio);
    return td;
  }

  const valor = linha[coluna.chave];
  td.textContent = valor === '' || valor === null || valor === undefined ? '—' : String(valor);
  return td;
}

function renderTabela() {
  const colunas = colunasAtuais();
  renderCabecalhoTabela(colunas);

  $('#busca').placeholder = estado.formato === 'orcamento'
    ? 'Buscar por grupo, código, ação, plano interno ou valor…'
    : 'Buscar por nome, matrícula, lotação ou valor…';

  const corpo = $('#corpo-tabela');
  corpo.innerHTML = '';

  for (const l of estado.linhas) {
    const tr = document.createElement('tr');
    tr.className = l.empenhado ? 'empenhada' : '';
    tr.dataset.id = l.id;

    // seleção em lote
    const tdSel = document.createElement('td');
    const sel = document.createElement('input');
    sel.type = 'checkbox';
    sel.className = 'selecao';
    sel.checked = estado.selecionados.has(l.id);
    sel.onchange = () => {
      sel.checked ? estado.selecionados.add(l.id) : estado.selecionados.delete(l.id);
      renderSelecao();
    };
    tdSel.appendChild(sel);
    tr.appendChild(tdSel);

    for (const c of colunas) tr.appendChild(montarCelula(l, c));

    // checkbox de empenho (ação principal)
    const tdStatus = document.createElement('td');
    const rotulo = document.createElement('label');
    rotulo.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = l.empenhado;
    chk.onchange = () => alternarEmpenho(l, chk);
    const txt = document.createElement('span');
    txt.className = 'etiqueta' + (l.empenhado ? ' ok' : '');
    txt.textContent = l.empenhado ? 'Empenhado' : 'Pendente';
    rotulo.append(chk, txt);
    tdStatus.appendChild(rotulo);
    tr.appendChild(tdStatus);

    corpo.appendChild(tr);
  }

  $('#tabela-vazia').hidden = estado.linhas.length > 0;
  renderSelecao();
}

/** "Selecionar todos" do cabeçalho — recriado a cada render da tabela. */
function alternarSelecaoTotal(e) {
  estado.selecionados.clear();
  if (e.target.checked) estado.linhas.forEach((l) => estado.selecionados.add(l.id));
  $$('#corpo-tabela .selecao').forEach((c) => { c.checked = e.target.checked; });
  renderSelecao();
}

function renderSelecao() {
  const n = estado.selecionados.size;
  const info = $('#selecao-info');
  info.hidden = n === 0;
  $('#btn-empenhar-lote').hidden = n === 0;
  $('#btn-estornar-lote').hidden = n === 0;
  if (!n) return;
  const total = estado.linhas
    .filter((l) => estado.selecionados.has(l.id))
    .reduce((s, l) => s + l.valorCentavos, 0);
  info.textContent = `${n} selecionado(s) · ${fmt(total)}`;
}

/* ---------------- ação de empenho ---------------- */

async function enviarEmpenho(ids, empenhar, forcar = false) {
  return api('/api/empenhos', {
    method: 'POST',
    body: JSON.stringify({ ids, empenhado: empenhar, forcar }),
  });
}

/** Aplica o retorno do servidor no estado local — cálculo em tempo real. */
function aplicarRetorno(resposta) {
  for (const atualizada of resposta.linhas || []) {
    const i = estado.linhas.findIndex((l) => l.id === atualizada.id);
    if (i >= 0) estado.linhas[i] = atualizada;
  }
  atualizarFonteLocal(resposta.fonte);
  renderPainel(resposta.fonte);
}

async function alternarEmpenho(linha, checkbox) {
  const empenhar = checkbox.checked;
  checkbox.disabled = true;
  try {
    let resposta;
    try {
      resposta = await enviarEmpenho([linha.id], empenhar);
    } catch (e) {
      if (e.dados?.erro !== 'TETO_EXCEDIDO') throw e;
      const ok = confirm(
        `${e.dados.mensagem}\n\n`
        + `Valor do item: ${fmt(e.dados.necessarioCentavos)}\n`
        + `Saldo disponível: ${fmt(e.dados.saldoCentavos)}\n`
        + `Excedente: ${fmt(e.dados.excedenteCentavos)}\n\n`
        + 'Deseja empenhar mesmo assim (ultrapassando o teto)?'
      );
      if (!ok) { checkbox.checked = !empenhar; return; }
      resposta = await enviarEmpenho([linha.id], empenhar, true);
    }

    linha.empenhado = empenhar;
    aplicarRetorno(resposta);

    const tr = $(`tr[data-id="${linha.id}"]`);
    if (tr) tr.className = empenhar ? 'empenhada' : '';
    const etiqueta = tr?.querySelector('.etiqueta');
    if (etiqueta) {
      etiqueta.textContent = empenhar ? 'Empenhado' : 'Pendente';
      etiqueta.className = 'etiqueta' + (empenhar ? ' ok' : '');
    }

    // Se um filtro de status está ativo, a linha pode ter saído da lista.
    if (estado.filtro.status !== 'todos') setTimeout(carregarLinhas, 400);
  } catch (e) {
    checkbox.checked = !empenhar;
    avisar(e.message, 'erro');
  } finally {
    checkbox.disabled = false;
  }
}

async function empenhoEmLote(empenhar) {
  const ids = Array.from(estado.selecionados);
  if (!ids.length) return;
  try {
    let resposta;
    try {
      resposta = await enviarEmpenho(ids, empenhar);
    } catch (e) {
      if (e.dados?.erro !== 'TETO_EXCEDIDO') throw e;
      const ok = confirm(
        `${e.dados.mensagem}\n\n`
        + `Total selecionado: ${fmt(e.dados.necessarioCentavos)}\n`
        + `Saldo disponível: ${fmt(e.dados.saldoCentavos)}\n`
        + `Excedente: ${fmt(e.dados.excedenteCentavos)}\n\n`
        + 'Deseja empenhar mesmo assim (ultrapassando o teto)?'
      );
      if (!ok) return;
      resposta = await enviarEmpenho(ids, empenhar, true);
    }
    avisar(`${resposta.alterados} item(ns) ${empenhar ? 'empenhado(s)' : 'estornado(s)'}.`, 'ok');
    estado.selecionados.clear();
    await carregarLinhas();
  } catch (e) {
    avisar(e.message, 'erro');
  }
}

/* ---------------- upload ---------------- */

const modal = $('#modal-upload');
let arquivoSelecionado = null;

function abrirUpload() {
  arquivoSelecionado = null;
  $('#nome-arquivo').textContent = '';
  $('#retorno-upload').hidden = true;
  $('#btn-enviar').disabled = true;
  $('#input-arquivo').value = '';
  modal.showModal();
}

function definirArquivo(arquivo) {
  arquivoSelecionado = arquivo;
  $('#nome-arquivo').textContent = arquivo ? `${arquivo.name} (${(arquivo.size / 1024).toFixed(0)} KB)` : '';
  $('#btn-enviar').disabled = !arquivo;
}

/** Envia o arquivo escolhido; `mapeamento` só vai quando a operadora aponta as colunas. */
async function postarArquivo(mapeamento) {
  const dados = new FormData();
  dados.append('arquivo', arquivoSelecionado);
  if (mapeamento) dados.append('mapeamento', JSON.stringify(mapeamento));

  const resposta = await fetch('/api/arquivos', { method: 'POST', body: dados });
  const json = await resposta.json();
  if (!resposta.ok) {
    throw Object.assign(new Error(json.erro || 'Falha ao processar a planilha.'), { dados: json });
  }
  return json;
}

async function enviarArquivo(mapeamento = null) {
  if (!arquivoSelecionado) return;
  const botao = $('#btn-enviar');
  const retorno = $('#retorno-upload');
  botao.disabled = true;
  botao.textContent = 'Processando…';

  try {
    const json = await postarArquivo(mapeamento);

    const colunas = Object.entries(json.colunasReconhecidas)
      .map(([campo, nome]) => `<li><b>${campo}</b> → coluna “${nome}”</li>`).join('');

    retorno.className = 'retorno ok';
    retorno.innerHTML =
      `<b>${json.linhasImportadas} linha(s) importada(s)</b> em ${json.fontesEncontradas} fonte(s) · `
      + `total ${fmt(json.valorTotalCentavos)}`
      + (json.linhasIgnoradas ? `<br>${json.linhasIgnoradas} linha(s) ignorada(s) (totais/linhas vazias).` : '')
      + (json.linhasNaoIdentificadas
          ? `<br><b>${json.linhasNaoIdentificadas} linha(s)</b> foram para a fonte `
            + `"${FONTE_NAO_IDENTIFICADA}" — a coluna Fonte não trazia uma fonte válida.`
          : '')
      + `<ul>${colunas}</ul>`
      + (json.avisos?.length ? `<ul>${json.avisos.map((a) => `<li>${a}</li>`).join('')}</ul>` : '');
    retorno.hidden = false;

    await carregarFontes(false);
    await carregarArquivos();
    avisar('Planilha importada com sucesso.', 'ok');
  } catch (e) {
    if (e.dados?.codigo === 'COLUNAS_NAO_IDENTIFICADAS' && e.dados.amostra) {
      modal.close();
      abrirMapeamento(e.dados.amostra, (mapeamento) => enviarArquivo(mapeamento));
      return;
    }
    retorno.className = 'retorno erro';
    retorno.textContent = e.message;
    retorno.hidden = false;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Enviar e processar';
  }
}

async function carregarArquivos() {
  const arquivos = await api('/api/arquivos');
  const lista = $('#lista-arquivos');
  lista.innerHTML = '';
  $('#secao-arquivos').hidden = arquivos.length === 0;

  for (const a of arquivos) {
    const li = document.createElement('li');
    const nome = document.createElement('b');
    nome.textContent = a.nomeOriginal;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${a.totalLinhas} linhas · ${fmt(a.valorTotalCentavos)} · ${a.enviadoEm}`;
    const espaco = document.createElement('span');
    espaco.className = 'espaco';
    const excluir = document.createElement('button');
    excluir.className = 'link-perigo';
    excluir.textContent = 'Excluir';
    excluir.onclick = async () => {
      if (!confirm(`Excluir "${a.nomeOriginal}" e todas as suas linhas?`)) return;
      await api(`/api/arquivos/${a.id}`, { method: 'DELETE' });
      await carregarFontes();
      await carregarArquivos();
      avisar('Planilha removida.', 'ok');
    };
    li.append(nome, meta, espaco, excluir);
    lista.appendChild(li);
  }
}

/* ---------------- eventos ---------------- */

$('#btn-abrir-upload').onclick = abrirUpload;
$('#btn-vazio-upload').onclick = abrirUpload;
$('#btn-cancelar-upload').onclick = () => modal.close();
$('#btn-enviar').onclick = enviarArquivo;

$('#area-drop').onclick = () => $('#input-arquivo').click();
$('#input-arquivo').onchange = (e) => definirArquivo(e.target.files[0]);
['dragover', 'dragenter'].forEach((ev) =>
  $('#area-drop').addEventListener(ev, (e) => { e.preventDefault(); $('#area-drop').classList.add('sobre'); }));
['dragleave', 'drop'].forEach((ev) =>
  $('#area-drop').addEventListener(ev, () => $('#area-drop').classList.remove('sobre')));
$('#area-drop').addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) definirArquivo(e.dataTransfer.files[0]);
});

$('#btn-salvar-teto').onclick = async () => {
  const centavos = paraCentavos($('#input-teto').value);
  try {
    const r = await api(`/api/fontes/${estado.fonteAtiva}/teto`, {
      method: 'PUT',
      body: JSON.stringify({ tetoCentavos: centavos }),
    });
    atualizarFonteLocal(r.fonte);
    renderPainel(r.fonte);
    avisar(`Teto de ${r.fonte.nome} definido em ${fmt(centavos)}.`, 'ok');
  } catch (e) {
    avisar(e.message, 'erro');
  }
};
$('#input-teto').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-salvar-teto').click(); });
// Ao sair do campo, normaliza o que foi digitado para o formato brasileiro.
$('#input-teto').addEventListener('blur', (e) => {
  const c = paraCentavos(e.target.value);
  e.target.value = c ? numeroBR.format(c / 100) : '';
});

let timerBusca;
$('#busca').oninput = (e) => {
  clearTimeout(timerBusca);
  const v = e.target.value;
  timerBusca = setTimeout(() => { estado.filtro.busca = v; carregarLinhas(); }, 280);
};

$$('#filtro-status button').forEach((b) => {
  b.onclick = () => {
    $$('#filtro-status button').forEach((x) => x.classList.remove('ativo'));
    b.classList.add('ativo');
    estado.filtro.status = b.dataset.status;
    estado.selecionados.clear();
    carregarLinhas();
  };
});

$('#btn-limpar-fontes').onclick = async () => {
  const vazias = estado.fontes.filter((f) => f.totalItens === 0 && f.tetoCentavos === 0);
  if (!vazias.length) return;

  const nomes = vazias.slice(0, 12).map((f) => `• ${f.nome}`);
  if (vazias.length > 12) nomes.push(`• … e mais ${vazias.length - 12}`);

  const pergunta = [
    `Remover ${vazias.length} fonte(s) sem itens e sem teto?`,
    '',
    ...nomes,
  ].join('\n');
  if (!confirm(pergunta)) return;

  let removidas = 0;
  for (const f of vazias) {
    try {
      await api(`/api/fontes/${f.id}`, { method: 'DELETE' });
      removidas++;
    } catch { /* fonte ganhou itens no meio do caminho: mantém */ }
  }
  await carregarFontes(false);
  avisar(`${removidas} fonte(s) removida(s).`, 'ok');
};

$('#btn-empenhar-lote').onclick = () => empenhoEmLote(true);
$('#btn-estornar-lote').onclick = () => empenhoEmLote(false);

/* ---------------- inicialização ---------------- */

(async function iniciar() {
  try {
    await carregarFontes(false);
    await carregarArquivos();
  } catch (e) {
    avisar(`Não foi possível carregar os dados: ${e.message}`, 'erro');
  }
})();
