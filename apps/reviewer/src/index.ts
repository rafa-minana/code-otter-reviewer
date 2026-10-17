import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "@otter/contracts";

const findings: Finding[] = [];
await writeFile(join(process.env.OUTPUT_DIR ?? "/out", "findings.json"), JSON.stringify(findings));
