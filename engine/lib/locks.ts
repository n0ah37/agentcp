import path from "node:path";

import { expandHome } from "./paths.ts";
import { refusalFor } from "./write.ts";

/** Whether the app can write a file at all, independent of the Allow edits switch. */
export function lockFor(p: string, extraRoots: string[] = []): { editable: boolean; lockedBecause: string | null } {
  const why = refusalFor(path.resolve(expandHome(p)), extraRoots);
  return { editable: !why, lockedBecause: why };
}
