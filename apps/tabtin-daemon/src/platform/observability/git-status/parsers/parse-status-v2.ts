import type { GitBranchInfo, GitFileEntry } from './types.js';

export interface StatusV2Result {
  branch: GitBranchInfo;
  files: GitFileEntry[];
  stash_count: number;
  modified_count: number;
  staged_count: number;
  untracked_count: number;
  deleted_count: number;
  conflict_count: number;
}

interface StatusAccumulator {
  branch: GitBranchInfo;
  files: GitFileEntry[];
  stashCount: number;
  stagedCount: number;
  untrackedCount: number;
  deletedCount: number;
  conflictCount: number;
}

function parseBranchLine(line: string, state: StatusAccumulator): boolean {
  if (line.startsWith('# branch.head ')) {
    const head = line.slice('# branch.head '.length);
    state.branch.head = head === '(detached)' ? null : head;
    return true;
  }
  if (line.startsWith('# branch.upstream ')) {
    state.branch.upstream = line.slice('# branch.upstream '.length);
    return true;
  }
  if (line.startsWith('# branch.ab ')) {
    const match = line.match(/\+(\d+) -(\d+)/);
    if (match) {
      state.branch.ahead = parseInt(match[1], 10);
      state.branch.behind = parseInt(match[2], 10);
    }
    return true;
  }
  return false;
}

function parseFileLine(line: string, state: StatusAccumulator): void {
  if (line.startsWith('1 ') || line.startsWith('2 ')) {
    for (const entry of parseOrdinaryEntry(line)) {
      state.files.push(entry);
      if (entry.is_staged) state.stagedCount++;
      if (entry.status === 'D') state.deletedCount++;
    }
    return;
  }
  if (line.startsWith('u ')) {
    state.conflictCount++;
    const path = extractConflictPath(line);
    if (path) state.files.push({ path, status: 'U', is_staged: false });
    return;
  }
  if (line.startsWith('? ')) {
    state.untrackedCount++;
    state.files.push({ path: line.slice(2), status: '?', is_staged: false });
  }
}

function parseStatusLine(line: string, state: StatusAccumulator): void {
  if (!line || parseBranchLine(line, state)) return;
  if (line.startsWith('# stash ')) {
    state.stashCount = parseInt(line.slice('# stash '.length), 10) || 0;
    return;
  }
  parseFileLine(line, state);
}

/**
 * Parse output of `git status --porcelain=v2 --branch --show-stash --untracked-files=all`.
 *
 * Reference: https://git-scm.com/docs/git-status#_porcelain_format_version_2
 */
export function parseStatusV2(output: string): StatusV2Result {
  const state: StatusAccumulator = {
    branch: { head: null, upstream: null, ahead: 0, behind: 0 },
    files: [],
    stashCount: 0,
    stagedCount: 0,
    untrackedCount: 0,
    deletedCount: 0,
    conflictCount: 0,
  };

  for (const line of output.split('\n')) {
    parseStatusLine(line, state);
  }

  const modifiedCount = state.files.filter(f => f.status === 'M' && !f.is_staged).length;

  return {
    branch: state.branch,
    files: state.files,
    stash_count: state.stashCount,
    modified_count: modifiedCount,
    staged_count: state.stagedCount,
    untracked_count: state.untrackedCount,
    deleted_count: state.deletedCount,
    conflict_count: state.conflictCount,
  };
}

function parseOrdinaryEntry(line: string): GitFileEntry[] {
  // Type 1: "1 XY sub mH mI mW hH hI path"
  // Type 2: "2 XY sub mH mI mW hH hI Xscore newPath\torigPath"
  const parts = line.split(' ');
  if (parts.length < 9) return [];

  const xy = parts[1];
  const x = xy[0]; // index (staged) status
  const y = xy[1]; // worktree (unstaged) status
  const isType2 = parts[0] === '2';

  let path: string;
  if (isType2) {
    // parts[8] = Xscore (e.g. R100), parts[9..] = "newPath\torigPath"
    const pathField = parts.slice(9).join(' ');
    const tabIdx = pathField.indexOf('\t');
    path = tabIdx >= 0 ? pathField.slice(0, tabIdx) : pathField;
  } else {
    path = parts.slice(8).join(' ');
  }

  const isStaged = x !== '.' && x !== '?';
  const hasWorktreeChange = y !== '.' && y !== '?';
  const entries: GitFileEntry[] = [];

  if (isStaged) {
    let status: GitFileEntry['status'] = 'M';
    if (isType2) {
      status = x === 'C' ? 'C' : 'R';
    } else if (x === 'A') {
      status = 'A';
    } else if (x === 'D') {
      status = 'D';
    }
    entries.push({ path, status, is_staged: true });
  }

  if (hasWorktreeChange) {
    let status: GitFileEntry['status'] = 'M';
    if (y === 'A') {
      status = 'A';
    } else if (y === 'D') {
      status = 'D';
    }
    entries.push({ path, status, is_staged: false });
  }

  return entries;
}

function extractConflictPath(line: string): string | null {
  // "u XY sub m1 m2 m3 mW h1 h2 h3 path"
  const parts = line.split(' ');
  return parts.length >= 11 ? parts.slice(10).join(' ') : null;
}
