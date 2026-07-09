import { Runtime } from "foldkit";

import { Model, init, update, view } from "./main.ts";
import { subscriptions } from "./subscriptions.ts";

const program = Runtime.makeProgram({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
});

Runtime.run(program);
