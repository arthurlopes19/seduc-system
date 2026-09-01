'use strict';

/*
 * Copia o conteúdo do SQLite local para o PostgreSQL de produção.
 *
 *   DATABASE_URL="postgres://…" npm run migrar
 *
 * Só faz sentido quando já existe trabalho feito no banco local (empenhos
 * marcados, tetos ajustados). Se o banco só tem uma planilha importada, é
 * mais simples subir o sistema na Vercel e importar a planilha de novo.
 *
 * A migração é abortada se o destino já tiver fontes — para não duplicar
 * dados por engano.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const URL_DESTINO = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!URL_DESTINO) {
  console.error('Defina DATABASE_URL com a URL do PostgreSQL de destino.');
  process.exit(1);
}

const CAMINHO_SQLITE = process.env.SEDUC_DB || path.join(__dirname, '..', 'data', 'empenho.db');
if (!fs.existsSync(CAMINHO_SQLITE)) {
  console.error(`Banco local não encontrado: ${CAMINHO_SQLITE}`);
  process.exit(1);
}

// A camada de dados aponta para o Postgres por causa da DATABASE_URL.
const { db, pronto } = require('../db');

const TABELAS = [
  {
    nome: 'fontes',
    colunas: ['id', 'nome', 'nome_normalizado', 'codigo', 'titulo',
      'meta_centavos', 'teto_centavos', 'criado_em', 'atualizado_em'],
  },
  {
    nome: 'arquivos',
    colunas: ['id', 'nome_original', 'competencia', 'total_linhas',
      'valor_total_centavos', 'enviado_em'],
  },
  {
    nome: 'linhas',
    colunas: ['id', 'arquivo_id', 'fonte_id', 'linha_planilha', 'matricula', 'nome',
      'cargo', 'lotacao', 'descricao', 'competencia', 'grupo', 'codigo', 'acao',
      'plano_interno', 'valor_centavos', 'empenhado', 'empenhado_em', 'empenhado_por',
      'dados_extra', 'busca_texto'],
  },
  {
    nome: 'movimentos',
    colunas: ['id', 'linha_id', 'acao', 'valor_centavos', 'usuario', 'criado_em'],
  },
];

(async () => {
  await pronto();

  const ocupado = await db.um('SELECT COUNT(*) AS n FROM fontes');
  if (Number(ocupado.n) > 0) {
    console.error(`Destino já tem ${ocupado.n} fonte(s). Esvazie antes de migrar.`);
    process.exit(1);
  }

  const origem = new DatabaseSync(CAMINHO_SQLITE, { readOnly: true });

  await db.emTransacao(async (tx) => {
    for (const tabela of TABELAS) {
      const registros = origem.prepare(`SELECT ${tabela.colunas.join(', ')} FROM ${tabela.nome} ORDER BY id`).all();
      if (!registros.length) {
        console.log(`${tabela.nome}: vazia`);
        continue;
      }

      const marcadores = tabela.colunas.map(() => '?').join(', ');
      const sql = `INSERT INTO ${tabela.nome} (${tabela.colunas.join(', ')})
                   OVERRIDING SYSTEM VALUE VALUES (${marcadores})`;

      for (const r of registros) {
        await tx.executar(sql, tabela.colunas.map((c) => r[c] ?? null));
      }
      console.log(`${tabela.nome}: ${registros.length} registro(s)`);

      // Realinha a sequência do id, senão o próximo INSERT colide.
      await tx.executar(
        `SELECT setval(pg_get_serial_sequence('${tabela.nome}', 'id'),
                       COALESCE((SELECT MAX(id) FROM ${tabela.nome}), 1))`
      );
    }
  });

  origem.close();
  console.log('\nMigração concluída.');
  process.exit(0);
})().catch((e) => {
  console.error('Falha na migração:', e.message);
  process.exit(1);
});
