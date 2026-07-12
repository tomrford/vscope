import { Schema, pipe } from "effect";
import { literal, mapTo, oneOf, parseUrlWithFallback, query, r, root } from "foldkit/route";
import type { Url } from "foldkit/url";

// The live scope is the root; snapshot viewing/comparison opens as its own
// route (usually a new tab) identified by the ids it plots.
export const LiveRoute = r("LiveRoute");
export type LiveRoute = typeof LiveRoute.Type;

export const SnapshotsRoute = r("SnapshotsRoute", {
  ids: Schema.optionalKey(Schema.String),
});
export type SnapshotsRoute = typeof SnapshotsRoute.Type;

export const NotFoundRoute = r("NotFoundRoute", { path: Schema.String });
export type NotFoundRoute = typeof NotFoundRoute.Type;

export const Route = Schema.Union([LiveRoute, SnapshotsRoute, NotFoundRoute]);
export type Route = Schema.Schema.Type<typeof Route>;

const liveRouter = pipe(root, mapTo(LiveRoute));

const snapshotsRouter = pipe(
  literal("snapshots"),
  query(Schema.Struct({ ids: Schema.optionalKey(Schema.String) })),
  mapTo(SnapshotsRoute),
);

const router = oneOf(liveRouter, snapshotsRouter);

export const parseRoute = (url: Url): Route => parseUrlWithFallback(router, NotFoundRoute)(url);

// The ids query parameter is a comma-separated list of snapshot ids.
export const routeSnapshotIds = (route: SnapshotsRoute): ReadonlyArray<string> =>
  (route.ids ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

export const snapshotsHref = (ids: ReadonlyArray<string>): string =>
  snapshotsRouter.build({ ids: ids.join(",") });

export const liveHref = (): string => liveRouter.build();
