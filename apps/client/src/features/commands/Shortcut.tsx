// A binding, rendered.
//
// One component so the five surfaces that teach the command layer — the rail's
// badge, a menu row's shortcut column, the palette, the ⌘/ sheet and the settings
// editor — cannot disagree about how a key is drawn, in the same way the binding
// table already keeps them from disagreeing about what it is.

import { Kbd } from "../../ui/kbd";
import { formatBindingParts, type Binding } from "./shortcuts";

export function Shortcut({
  binding,
  plain = false,
  className,
}: {
  binding: Binding;
  plain?: boolean;
  className?: string;
}) {
  return <Kbd parts={formatBindingParts(binding)} plain={plain} className={className} />;
}
