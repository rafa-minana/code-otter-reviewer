import type { Finding } from "@otter/contracts";

// Test-only data.

export const DIFF =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n" +
  "@@ -1,3 +1,3 @@\n x\n-y\n+z\n w\n" +
  "@@ -20,2 +20,3 @@ fn\n p\n+q\n r\n";

export const finding = (
  line: number,
  body = "bug",
  path = "a.ts",
): Finding => ({
  path,
  line,
  side: "RIGHT",
  severity: "major",
  body,
  confidence: 0.9,
});
