import { pnpmPlan } from '../shared/package-command.mjs';

export function resolvePackagePlan({ rootDir, platform }) {
  return {
    ...pnpmPlan(['--filter', 'tabtin-web', 'build'], platform),
    cwd: rootDir,
  };
}
