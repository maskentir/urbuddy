import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReferenceTrace, serializeReference } from "../reference.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const target = join(here, "..", "trace", "reference.jsonl");

const lines = await buildReferenceTrace();
writeFileSync(target, serializeReference(lines));
process.stdout.write(`reference: ${target} (${lines.length} lines)\n`);
