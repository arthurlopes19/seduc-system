'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.SEDUC_DB || path.join(DATA_DIR, 'empenho.db');

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/*
 * ------------------------------------------------------------------
 * ESQUEMA
 * ------------------------------------------------------------------
 * fontes      -> catalogo de fontes de recurso + teto orcamentario
 * arquivos    -> cada planilha importada (lote)
 * linhas      -> cada linha da planilha, ligada a uma fonte
 * movimentos  -> auditoria de empenho / estorno
 *
 * Todos os valores monetarios sao guardados em CENTAVOS (INTEGER)
 * para evitar erro de ponto flutuante nas somas.
 * ------------------------------------------------------------------
 */
db.exec(`
CREATE TABLE IF NOT EXISTS fontes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  nome              TEXT    NOT NULL,
  nome_normalizado  TEXT    NOT NULL UNIQUE,
  codigo            TEXT,
  titulo            TEXT,
  meta_centavos     INTEGER NOT NULL DEFAULT 0,
  teto_centavos     INTEGER NOT NULL DEFAULT 0,
  criado_em         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  atualizado_em     TEXT
);

CREATE TABLE IF NOT EXISTS arquivos (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_original         TEXT    NOT NULL,
  competencia           TEXT,
  total_linhas          INTEGER NOT NULL DEFAULT 0,
  valor_total_centavos  INTEGER NOT NULL DEFAULT 0,
  enviado_em            TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS linhas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  arquivo_id      INTEGER NOT NULL REFERENCES arquivos(id) ON DELETE CASCADE,
  fonte_id        INTEGER NOT NULL REFERENCES fontes(id),
  linha_planilha  INTEGER,
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
  valor_centavos  INTEGER NOT NULL DEFAULT 0,
  empenhado       INTEGER NOT NULL DEFAULT 0,
  empenhado_em    TEXT,
  empenhado_por   TEXT,
  dados_extra     TEXT
);

CREATE INDEX IF NOT EXISTS idx_linhas_fonte    ON linhas(fonte_id);
CREATE INDEX IF NOT EXISTS idx_linhas_arquivo  ON linhas(arquivo_id);
CREATE INDEX IF NOT EXISTS idx_linhas_status   ON linhas(fonte_id, empenhado);

CREATE TABLE IF NOT EXISTS movimentos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  linha_id        INTEGER NOT NULL REFERENCES linhas(id) ON DELETE CASCADE,
  acao            TEXT    NOT NULL,
  valor_centavos  INTEGER NOT NULL,
  usuario         TEXT,
  criado_em       TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_movimentos_linha ON movimentos(linha_id);
`);

/*
 * Migracao leve: bancos criados antes da planilha padrao (uma aba por fonte)
 * nao tem as colunas orcamentarias. Adiciona o que faltar, sem perder dados.
 */
function garantirColuna(tabela, coluna, definicao) {
  const existe = db.prepare(`PRAGMA table_info(${tabela})`).all()
    .some((c) => c.name === coluna);
  if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
}

garantirColuna('fontes', 'codigo', 'TEXT');
garantirColuna('fontes', 'titulo', 'TEXT');
garantirColuna('fontes', 'meta_centavos', 'INTEGER NOT NULL DEFAULT 0');
garantirColuna('linhas', 'grupo', 'TEXT');
garantirColuna('linhas', 'codigo', 'TEXT');
garantirColuna('linhas', 'acao', 'TEXT');
garantirColuna('linhas', 'plano_interno', 'TEXT');
// Texto de todos os campos pesquisaveis, sem acento e em caixa alta: o UPPER()
// do SQLite so entende ASCII, entao "Auxílio" nunca casaria com "AUXÍLIO".
garantirColuna('linhas', 'busca_texto', 'TEXT');

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fontes_codigo ON fontes(codigo) WHERE codigo IS NOT NULL;');

module.exports = { db, DB_PATH };
