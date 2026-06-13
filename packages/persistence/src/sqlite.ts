import { createRequire } from "node:module";

export type SqliteRunResult = {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
};

export type SqliteStatement = {
  readonly all: (...params: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
  readonly get: (...params: ReadonlyArray<unknown>) => unknown;
  readonly run: (...params: ReadonlyArray<unknown>) => SqliteRunResult;
};

export type SqliteDatabase = {
  readonly exec: (source: string) => unknown;
  readonly prepare: (source: string) => SqliteStatement;
  readonly transaction: <A>(run: () => A) => () => A;
  readonly close: () => void;
};

type SqliteDatabaseConstructor = new (path: string) => SqliteDatabase;

type BunSqliteModule = {
  readonly Database: SqliteDatabaseConstructor;
};

const require = createRequire(import.meta.url);

export async function openSqliteDatabase(path: string): Promise<SqliteDatabase> {
  if (process.versions.bun) {
    const sqlite = (await import("bun:sqlite")) as BunSqliteModule;
    return new sqlite.Database(path);
  }

  const Database = require("better-sqlite3") as SqliteDatabaseConstructor;
  return new Database(path);
}
