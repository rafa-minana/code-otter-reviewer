// Types internal to the reviewer. Messages that cross processes live in @otter/contracts.

export interface Hunk {
  header: string; // "@@ -a,b +c,d @@ function"
  newStart: number;
  lines: string[]; // each keeps its " ", "+" or "-" prefix
}

export interface FileDiff {
  path: string;
  deleted: boolean;
  binary: boolean;
  hunks: Hunk[];
}

export interface Chunk {
  text: string;
  paths: string[];
}

export interface ChunkedDiff {
  chunks: Chunk[];
  filtered: string[];
  deleted: string[];
  notReviewed: string[];
}
