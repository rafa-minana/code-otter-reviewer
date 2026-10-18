import type { ReviewerOutput, Severity } from "@otter/contracts";

// GitHub's native alerts (> [!TYPE]): coloured blocks with an icon. Language-agnostic, so not in the JSON files.
export type AlertType = "CAUTION" | "WARNING" | "NOTE" | "TIP";

export const ALERT_BY_SEVERITY: Record<Severity, AlertType> = {
  critical: "CAUTION", // red
  major: "WARNING", // orange
  minor: "NOTE", // blue
  nit: "TIP", // green
};

export const ALERT_BY_RISK: Record<ReviewerOutput["risk"], AlertType> = {
  high: "CAUTION",
  medium: "WARNING",
  low: "TIP",
};

/** Column order of the findings table in the summary. */
export const SEVERITIES: Severity[] = ["critical", "major", "minor", "nit"];
