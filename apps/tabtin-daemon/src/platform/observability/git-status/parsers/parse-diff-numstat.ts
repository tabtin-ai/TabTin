export interface DiffNumstatResult {
  total_added: number;
  total_removed: number;
  files: Map<string, { added: number; removed: number }>;
}

/**
 * Parse output of `git diff --numstat` or `git diff --cached --numstat`.
 *
 * Each line: "added\tremoved\tpath"
 * Binary files show "-\t-\tpath"
 */
export function parseDiffNumstat(output: string): DiffNumstatResult {
  let totalAdded = 0;
  let totalRemoved = 0;
  const files = new Map<string, { added: number; removed: number }>();

  for (const line of output.split('\n')) {
    if (!line) continue;

    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [addedStr, removedStr, ...pathParts] = parts;
    const path = pathParts.join('\t');

    if (addedStr === '-' || removedStr === '-') {
      // binary file
      files.set(path, { added: 0, removed: 0 });
      continue;
    }

    const added = parseInt(addedStr, 10) || 0;
    const removed = parseInt(removedStr, 10) || 0;

    totalAdded += added;
    totalRemoved += removed;
    files.set(path, { added, removed });
  }

  return { total_added: totalAdded, total_removed: totalRemoved, files };
}
