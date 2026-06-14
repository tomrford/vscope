import fs from "node:fs";
import nodePath from "node:path";

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Context, Effect, Layer } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { Persistence, type OpenPersistenceOptions } from "./api.ts";
import {
  PersistenceMigrationError,
  PersistenceOpenError,
  errorReason,
  type PersistenceError,
} from "./errors.ts";
import { persistenceMigrations } from "./migrations.ts";
import { makePersistence } from "./service.ts";

function openError(path: string, cause: unknown): PersistenceOpenError {
  return PersistenceOpenError.make({
    path,
    reason: errorReason(cause),
    cause,
  });
}

function migrationError(cause: unknown): PersistenceMigrationError {
  return PersistenceMigrationError.make({
    migration: "foundation",
    reason: errorReason(cause),
    cause,
  });
}

function mapMigrationFailure<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, PersistenceMigrationError, R> {
  return effect.pipe(
    Effect.mapError((cause) => migrationError(cause)),
    Effect.catchDefect((defect) => Effect.fail(migrationError(defect))),
  );
}

const setupPersistence = Effect.fn("Persistence.setup")(function* (
  migrate: boolean,
): Effect.fn.Return<void, PersistenceMigrationError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  yield* mapMigrationFailure(sql`PRAGMA foreign_keys = ON`);

  if (migrate) {
    yield* mapMigrationFailure(
      SqliteMigrator.run({
        loader: persistenceMigrations,
        table: "persistence_migrations",
      }),
    );
  }
});

function makeSqliteLayer(
  path: string,
): Layer.Layer<SqliteClient.SqliteClient | SqlClient.SqlClient, PersistenceOpenError> {
  return Layer.effectContext(
    SqliteClient.make({ filename: path }).pipe(
      Effect.catchDefect((defect) => Effect.fail(openError(path, defect))),
      Effect.map((client) =>
        Context.make(SqliteClient.SqliteClient, client).pipe(
          Context.add(SqlClient.SqlClient, client),
        ),
      ),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
}

export function makePersistenceLayer(
  options: OpenPersistenceOptions,
): Layer.Layer<Persistence, PersistenceOpenError | PersistenceError> {
  try {
    fs.mkdirSync(nodePath.dirname(options.path), { recursive: true });
  } catch (cause) {
    return Layer.effect(Persistence, Effect.fail(openError(options.path, cause)));
  }

  const sqlLayer = makeSqliteLayer(options.path);
  const setupLayer = Layer.effectDiscard(setupPersistence(options.migrate !== false));
  const serviceLayer = Layer.effect(Persistence, makePersistence(options.path));

  return Layer.mergeAll(setupLayer, serviceLayer).pipe(Layer.provide(sqlLayer));
}

export function initializePersistence(
  options: OpenPersistenceOptions,
): Effect.Effect<void, PersistenceOpenError | PersistenceError> {
  return Effect.scoped(
    Effect.asVoid(Persistence).pipe(Effect.provide(makePersistenceLayer(options))),
  );
}
