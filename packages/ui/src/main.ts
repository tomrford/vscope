import { Match, Schema } from "effect";
import { Command, Runtime } from "foldkit";
import type { Document } from "foldkit/html";
import { html } from "foldkit/html";
import { m } from "foldkit/message";

export const Model = Schema.Struct({
  appName: Schema.String,
  status: Schema.String,
});

export type Model = Schema.Schema.Type<typeof Model>;

const RuntimeStateLoaded = m("RuntimeStateLoaded", {
  status: Schema.String,
});

export const Message = Schema.Union([RuntimeStateLoaded]);
export type Message = Schema.Schema.Type<typeof Message>;

export const init: Runtime.ProgramInit<Model, Message> = () => [
  {
    appName: "vscope",
    status: "Waiting for runtime",
  },
  [],
];

export const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  Match.value(message).pipe(
    Match.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    Match.tagsExhaustive({
      RuntimeStateLoaded: ({ status }) => [
        {
          ...model,
          status,
        },
        [],
      ],
    }),
  );

export const view = (model: Model): Document => {
  const h = html<Message>();

  return {
    title: model.appName,
    body: h.main(
      [h.Class("min-h-screen bg-zinc-950 text-zinc-100 flex flex-col justify-center gap-4 px-8")],
      [
        h.h1([h.Class("text-3xl font-semibold tracking-normal")], [model.appName]),
        h.p([h.Class("text-sm text-zinc-300")], [model.status]),
      ],
    ),
  };
};
