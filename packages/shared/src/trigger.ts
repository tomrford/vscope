import { Schema } from "effect";

export const TriggerMode = Schema.Literals(["disabled", "rising", "falling", "both"]);
export type TriggerMode = Schema.Schema.Type<typeof TriggerMode>;
