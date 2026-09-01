'use strict';

/*
 * ------------------------------------------------------------------
 * CAMADA DE DADOS — dois drivers, uma API
 * ------------------------------------------------------------------
 * local        -> SQLite (node:sqlite), arquivo em data/empenho.db
 * produção     -> PostgreSQL, quando existir DATABASE_URL / POSTGRES_URL
 *
 * A Vercel roda funções serverless com disco efêmero: o arquivo do SQLite
 * seria apagado a cada execução. Por isso, em produção, Postgres.
 *
 * Tudo é assíncrono nos dois casos, para o servidor não precisar saber qual
 * driver está ativo. O SQL é escrito com `?` e o adaptador do Postgres troca
 * por $1, $2… Aliases em camelCase vão entre aspas porque o Postgres
 * rebaixaria `AS arquivoId` para `arquivoid`.
 * ------------------------------------------------------------------
 */

const path = require('node:path');
const fs = require('node:fs');

const URL_POSTGRES = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const DRIVER = URL_POSTGRES ? 'postgres' : 'sqlite';

/** Data/hora local no formato que a interface exibe. */
function agora() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ *
 * Esquema — mesmo modelo nos dois bancos
 * ------------------------------------------------------------------ */

const TIPO = {
  sqlite: { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', inteiro: 'INTEGER', binario: 'BLOB' },
  postgres: { id: 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY', inteiro: 'BIGINT', binario: 'BYTEA' },
};

function esquema(driver) {
  const t = TIPO[driver];
  return [
    `CREATE TABLE IF NOT EXISTS fontes (
      id                ${t.id},
      nome              TEXT NOT NULL,
      nome_normalizado  TEXT NOT NULL UNIQUE,
      codigo            TEXT,
      titulo            TEXT,
      meta_centavos     ${t.inteiro} NOT NULL DEFAULT 0,
      teto_centavos     ${t.inteiro} NOT NULL DEFAULT 0,
      criado_em         TEXT,
      atualizado_em     TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS arquivos (
      id                    ${t.id},
      nome_original         TEXT NOT NULL,
      competencia           TEXT,
      total_linhas          ${t.inteiro} NOT NULL DEFAULT 0,
      valor_total_centavos  ${t.inteiro} NOT NULL DEFAULT 0,
      enviado_em            TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS linhas (
      id              ${t.id},
      arquivo_id      ${t.inteiro} NOT NULL REFERENCES arquivos(id) ON DELETE CASCADE,
      fonte_id        ${t.inteiro} NOT NULL REFERENCES fontes(id),
      linha_planilha  ${t.inteiro},
      matricula       TEXT,
      nome            TEXT,
      cargo           TEXT,
      lotacao         TEXT,
      descricao       TEXT,
      competencia     TEXT,
      grupo           TEXT,
      codigo          TEXT,
      acao            TEXT,
      plano_interno   TEXT,
      valor_centavos  ${t.inteiro} NOT NULL DEFAULT 0,
      empenhado       ${t.inteiro} NOT NULL DEFAULT 0,
      empenhado_em    TEXT,
      empenhado_por   TEXT,
      dados_extra     TEXT,
      busca_texto     TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS movimentos (
      id              ${t.id},
      linha_id        ${t.inteiro} NOT NULL REFERENCES linhas(id) ON DELETE CASCADE,
      acao            TEXT NOT NULL,
      valor_centavos  ${t.inteiro} NOT NULL,
      usuario         TEXT,
      criado_em       TEXT
    )`,

    // Arquivos convertidos aguardando download/importação. Em serverless não
    // dá para guardar em memória: cada requisição pode cair em outra máquina.
    `CREATE TABLE IF NOT EXISTS conversoes (
      id          TEXT PRIMARY KEY,
      nome_saida  TEXT NOT NULL,
      conteudo    ${t.binario} NOT NULL,
      criado_em   TEXT NOT NULL
    )`,

    'CREATE INDEX IF NOT EXISTS idx_linhas_fonte   ON linhas(fonte_id)',
    'CREATE INDEX IF NOT EXISTS idx_linhas_arquivo ON linhas(arquivo_id)',
    'CREATE INDEX IF NOT EXISTS idx_linhas_status  ON linhas(fonte_id, empenhado)',
    'CREATE INDEX IF NOT EXISTS idx_movimentos_linha ON movimentos(linha_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_fontes_codigo ON fontes(codigo) WHERE codigo IS NOT NULL',
  ];
}

/** Colunas acrescentadas depois da primeira versão do sistema. */
const COLUNAS_NOVAS = [
  ['fontes', 'codigo', 'TEXT'],
  ['fontes', 'titulo', 'TEXT'],
  ['fontes', 'meta_centavos', 'INTEGER NOT NULL DEFAULT 0'],
  ['linhas', 'grupo', 'TEXT'],
  ['linhas', 'codigo', 'TEXT'],
  ['linhas', 'acao', 'TEXT'],
  ['linhas', 'plano_interno', 'TEXT'],
  ['linhas', 'busca_texto', 'TEXT'],
];

/* ------------------------------------------------------------------ *
 * Driver SQLite
 * ------------------------------------------------------------------ */

function criarSqlite() {
  const { DatabaseSync } = require('node:sqlite');

  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const caminho = process.env.SEDUC_DB || path.join(DATA_DIR, 'empenho.db');

  const banco = new DatabaseSync(caminho);
  banco.exec('PRAGMA journal_mode = WAL;');
  banco.exec('PRAGMA foreign_keys = ON;');

  for (const ddl of esquema('sqlite')) banco.exec(ddl);

  // Bancos criados por versões anteriores podem não ter as colunas novas.
  for (const [tabela, coluna, definicao] of COLUNAS_NOVAS) {
    const existe = banco.prepare(`PRAGMA table_info(${tabela})`).all()
      .some((c) => c.name === coluna);
    if (!existe) banco.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  }

  const executor = {
    async consulta(sql, params = []) {
      return banco.prepare(sql).all(...params);
    },
    async um(sql, params = []) {
      return banco.prepare(sql).get(...params) ?? null;
    },
    async executar(sql, params = []) {
      const r = banco.prepare(sql).run(...params);
      return { alteradas: r.changes, id: r.lastInsertRowid === undefined ? null : Number(r.lastInsertRowid) };
    },
  };

  return {
    driver: 'sqlite',
    caminho,
    ...executor,
    async emTransacao(fn) {
      banco.exec('BEGIN');
      try {
        const r = await fn(executor);
        banco.exec('COMMIT');
        return r;
      } catch (e) {
        banco.exec('ROLLBACK');
        throw e;
      }
    },
    async encerrar() { banco.close(); },
  };
}

/* ------------------------------------------------------------------ *
 * Driver PostgreSQL
 * ------------------------------------------------------------------ */

/** `SELECT ... WHERE a = ? AND b = ?` -> `... WHERE a = $1 AND b = $2` */
function paraPlaceholdersNumerados(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function criarPostgres() {
  const pg = require('pg');

  // BIGINT chega como string por padrão; os centavos precisam ser número.
  // O maior valor aqui (bilhões de reais em centavos) cabe com folga no
  // inteiro seguro do JavaScript.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

  const pool = new pg.Pool({
    connectionString: URL_POSTGRES,
    ssl: /localhost|127\.0\.0\.1/.test(URL_POSTGRES) ? false : { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  const executorDe = (cliente) => ({
    async consulta(sql, params = []) {
      const r = await cliente.query(paraPlaceholdersNumerados(sql), params);
      return r.rows;
    },
    async um(sql, params = []) {
      const r = await cliente.query(paraPlaceholdersNumerados(sql), params);
      return r.rows[0] ?? null;
    },
    async executar(sql, params = []) {
      const r = await cliente.query(paraPlaceholdersNumerados(sql), params);
      return { alteradas: r.rowCount, id: r.rows?.[0]?.id ?? null };
    },
  });

  const executor = executorDe(pool);

  return {
    driver: 'postgres',
    ...executor,
    async preparar() {
      for (const ddl of esquema('postgres')) await pool.query(ddl);
      for (const [tabela, coluna, definicao] of COLUNAS_NOVAS) {
        const tipo = definicao.replace('INTEGER', 'BIGINT');
        await pool.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS ${coluna} ${tipo}`);
      }
    },
    async emTransacao(fn) {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        const r = await fn(executorDe(cliente));
        await cliente.query('COMMIT');
        return r;
      } catch (e) {
        await cliente.query('ROLLBACK');
        throw e;
      } finally {
        cliente.release();
      }
    },
    async encerrar() { await pool.end(); },
  };
}

/* ------------------------------------------------------------------ */

const db = DRIVER === 'postgres' ? criarPostgres() : criarSqlite();

/** Garante que o esquema existe. Idempotente e seguro para chamar sempre. */
let preparacao = null;
function pronto() {
  if (!preparacao) preparacao = db.preparar ? db.preparar() : Promise.resolve();
  return preparacao;
}

module.exports = { db, pronto, agora, DRIVER };
