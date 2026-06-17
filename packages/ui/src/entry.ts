import { Runtime } from "foldkit";

import { Model, init, update, view } from "./main.ts";

const program = Runtime.makeProgram({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
});

Runtime.run(program);
