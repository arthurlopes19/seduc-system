/* ------------------------------------------------------------------
   SEDUC · Conversor de arquivos para Excel
   Depende de app.js (helpers $, avisar, api, carregarFontes…).
   ------------------------------------------------------------------ */
'use strict';

const conv = {
  arquivo: null,
  resultado: null,
  abaPrevia: 0,
  historico: [],
};

/* ---------------- navegação entre as views ---------------- */

function trocarView(nome) {
  document.querySelectorAll('#nav-principal button').forEach((b) => {
    b.classList.toggle('ativo', b.dataset.view === nome);
  });
  $('#view-empenho').hidden = nome !== 'empenho';
  $('#view-conversor').hidden = nome !== 'conversor';
  // O botão de importar planilha pertence ao fluxo de empenho.
  $('#btn-abrir-upload').hidden = nome !== 'empenho';
}

document.querySelectorAll('#nav-principal button').forEach((b) => {
  b.onclick = () => trocarView(b.dataset.view);
});

/* ---------------- seleção de arquivo ---------------- */

function definirArquivoConv(arquivo) {
  conv.arquivo = arquivo;
  $('#conv-nome').textContent = arquivo
    ? `${arquivo.name} (${(arquivo.size / 1024).toFixed(0)} KB)`
    : '';
  $('#conv-converter').disabled = !arquivo;
  $('#conv-retorno').hidden = true;
}

$('#conv-drop').onclick = () => $('#conv-arquivo').click();
$('#conv-arquivo').onchange = (e) => definirArquivoConv(e.target.files[0]);

['dragover', 'dragenter'].forEach((ev) =>
  $('#conv-drop').addEventListener(ev, (e) => {
    e.preventDefault();
    $('#conv-drop').classList.add('sobre');
  }));
['dragleave', 'drop'].forEach((ev) =>
  $('#conv-drop').addEventListener(ev, () => $('#conv-drop').classList.remove('sobre')));
$('#conv-drop').addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) definirArquivoConv(e.dataTransfer.files[0]);
});

/* ---------------- conversão ---------------- */

$('#conv-converter').onclick = async () => {
  if (!conv.arquivo) return;

  const botao = $('#conv-converter');
  const retorno = $('#conv-retorno');
  botao.disabled = true;
  botao.textContent = 'Convertendo…';
  retorno.hidden = true;

  try {
    const dados = new FormData();
    dados.append('arquivo', conv.arquivo);
    dados.append('umaAbaPorPagina',
      document.querySelector('input[name="conv-abas"]:checked').value === 'pagina');
    dados.append('removerCabecalhosRepetidos', $('#conv-remover-cabecalho').checked);

    const resposta = await fetch('/api/converter', { method: 'POST', body: dados });
    const json = await resposta.json();
    if (!resposta.ok) throw new Error(json.erro || 'Falha na conversão.');

    conv.resultado = json;
    conv.abaPrevia = 0;
    conv.historico.unshift(json);
    renderResultadoConv();
    renderHistoricoConv();
    avisar(`${json.nomeSaida} gerado com ${json.totalLinhas} linha(s).`, 'ok');
  } catch (e) {
    retorno.className = 'retorno erro';
    retorno.textContent = e.message;
    retorno.hidden = false;
    $('#conv-resultado').hidden = true;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Converter para Excel';
  }
};

function renderResultadoConv() {
  const r = conv.resultado;
  if (!r) return;

  $('#conv-r-nome').textContent = r.nomeSaida;
  $('#conv-r-origem').textContent = r.origem;
  $('#conv-r-abas').textContent = r.abas.length;
  $('#conv-r-linhas').textContent = r.totalLinhas.toLocaleString('pt-BR');
  $('#conv-baixar').href = r.downloadUrl;
  $('#conv-baixar').setAttribute('download', r.nomeSaida);

  // abas da prévia
  const abas = $('#conv-abas-previa');
  abas.innerHTML = '';
  r.abas.forEach((aba, i) => {
    const btn = document.createElement('button');
    btn.className = 'aba' + (i === conv.abaPrevia ? ' ativa' : '');
    btn.onclick = () => { conv.abaPrevia = i; renderResultadoConv(); };

    const nome = document.createElement('span');
    nome.textContent = aba.nome;
    const pastilha = document.createElement('span');
    pastilha.className = 'pastilha';
    pastilha.textContent = `${aba.linhas} × ${aba.colunas}`;

    btn.append(nome, pastilha);
    abas.appendChild(btn);
  });

  // tabela da prévia
  const corpo = $('#conv-previa');
  corpo.innerHTML = '';
  const previa = r.previas[conv.abaPrevia]?.previa || [];
  const colunas = previa.reduce((m, l) => Math.max(m, l.length), 0);

  previa.forEach((linha, i) => {
    const tr = document.createElement('tr');
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

  const total = r.abas[conv.abaPrevia]?.linhas || 0;
  $('#conv-previa-nota').textContent = total > previa.length
    ? `Mostrando as ${previa.length} primeiras de ${total} linhas — o arquivo baixado traz tudo.`
    : `${total} linha(s) — prévia completa.`;

  $('#conv-resultado').hidden = false;
}

/* ---------------- importar direto para o empenho ---------------- */

async function importarConvertido(mapeamento = null) {
  const r = conv.resultado;
  const json = await api(`/api/converter/${r.id}/importar`, {
    method: 'POST',
    body: JSON.stringify({ mapeamento }),
  });
  await carregarFontes(false);
  await carregarArquivos();
  trocarView('empenho');
  avisar(
    `${json.linhasImportadas} linha(s) importada(s) em ${json.fontesEncontradas} fonte(s).`,
    'ok'
  );
  return json;
}

$('#conv-importar').onclick = async () => {
  if (!conv.resultado) return;

  const botao = $('#conv-importar');
  botao.disabled = true;
  botao.textContent = 'Importando…';

  try {
    await importarConvertido();
  } catch (e) {
    // Colunas não reconhecidas: em vez de mandar o usuário para o Excel,
    // abre a tela onde ele aponta Fonte e Valor no que foi lido.
    if (e.dados?.codigo === 'COLUNAS_NAO_IDENTIFICADAS' && e.dados.amostra) {
      abrirMapeamento(e.dados.amostra, (mapeamento) => importarConvertido(mapeamento));
    } else {
      const retorno = $('#conv-retorno');
      retorno.className = 'retorno erro';
      retorno.innerHTML = `<b>Não foi possível importar para o empenho:</b><br>${e.message}`
        + '<br><br>O arquivo convertido continua disponível para download.';
      retorno.hidden = false;
    }
  } finally {
    botao.disabled = false;
    botao.textContent = 'Importar para o empenho';
  }
};

/* ---------------- histórico da sessão ---------------- */

function renderHistoricoConv() {
  const lista = $('#conv-historico');
  lista.innerHTML = '';
  $('#conv-historico-secao').hidden = conv.historico.length === 0;

  for (const item of conv.historico) {
    const li = document.createElement('li');

    const nome = document.createElement('b');
    nome.textContent = item.nomeSaida;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${item.origem} · ${item.abas.length} aba(s) · ${item.totalLinhas} linhas`;

    const espaco = document.createElement('span');
    espaco.className = 'espaco';

    const baixar = document.createElement('a');
    baixar.className = 'btn btn-secundario';
    baixar.href = item.downloadUrl;
    baixar.setAttribute('download', item.nomeSaida);
    baixar.textContent = 'Baixar';

    li.append(nome, meta, espaco, baixar);
    lista.appendChild(li);
  }
}
