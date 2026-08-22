import { pnpmPlan } from '../shared/package-command.mjs';

export function resolvePackagePlan({ rootDir, platform }) {
  return {
    ...pnpmPlan(['--filter', 'admindash', 'build'], platform),
    cwd: rootDir,
  };
}
