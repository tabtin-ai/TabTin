import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { listPersonalPluginEnablement } from '../plugins/index.js';
import { parseSkillDoc } from './skill-doc-parser.js';
import { buildCanonicalKey } from './skill-renderer.js';
import type { LocalSkill } from './skill-types.js';

export interface PersonalPluginSkillSnapshot {
  enabledPluginIds: string[];
  skills: LocalSkill[];
}

export interface LoadEnabledPersonalPluginSkillSnapshotOptions {
  /**  / （硬切）：组织级 plugins 存储必填。 */
  userId: string;
  dataRoot?: string;
  organizationId: string;
  /** 业务字段：仅用于标注返回 LocalSkill 的 spaceId / scope 元数据，与存储路径无关。 */
  spaceId: string;
  onWarn?: (message: string) => void;
}

export function mergeSkillListsForRuntime(
  baseSkills: LocalSkill[],
  personalPluginSkills: LocalSkill[],
): LocalSkill[] {
  if (personalPluginSkills.length === 0) return baseSkills;
  const byKey = new Map<string, LocalSkill>();
  for (const skill of baseSkills) byKey.set(skill.canonicalKey, skill);
  for (const skill of personalPluginSkills) byKey.set(skill.canonicalKey, skill);
  return Array.from(byKey.values()).sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
}

function skillMatchesQuery(skill: LocalSkill, query: string): boolean {
  const haystack = [
    skill.canonicalKey,
    skill.slug,
    skill.name,
    skill.displayName ?? '',
    skill.description,
    skill.whenToUse ?? '',
  ].join('\n').toLowerCase();
  return haystack.includes(query);
}

function firstLocalServiceId(localServices: unknown[]): string | undefined {
  for (const raw of localServices) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const id = record.id ?? record.name;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

function isRuntimeLaunchSkill(parsed: NonNullable<ReturnType<typeof parseSkillDoc>>, capabilityId: string): boolean {
  const haystack = [
    capabilityId,
    parsed.frontmatter.slug,
    parsed.frontmatter.name,
    parsed.frontmatter.displayName ?? '',
    parsed.frontmatter.description,
    parsed.frontmatter.when_to_use ?? '',
  ].join('\n').toLowerCase();
  const hasLaunchVerb = /\b(open|launch|start|show)\b/.test(haystack);
  const hasRuntimeTarget = /\b(canvas|service|runtime|browser|web)\b/.test(haystack);
  return hasLaunchVerb && hasRuntimeTarget;
}

export function searchRuntimeSkills(
  skills: LocalSkill[],
  query: string,
  options?: { limit?: number },
): LocalSkill[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const limit = options?.limit ?? 20;
  return skills
    .filter((skill) => skillMatchesQuery(skill, normalized))
    .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey))
    .slice(0, limit);
}

export async function loadEnabledPersonalPluginSkillSnapshot(
  options: LoadEnabledPersonalPluginSkillSnapshotOptions,
): Promise<PersonalPluginSkillSnapshot> {
  const enabledPlugins = (await listPersonalPluginEnablement({
    userId: options.userId,
    dataRoot: options.dataRoot,
    organizationId: options.organizationId,
  })).filter((plugin) => plugin.enabled);
  const skills: LocalSkill[] = [];

  for (const plugin of enabledPlugins) {
    const serviceId = firstLocalServiceId(plugin.capabilityManifest.localServices);
    const pluginRuntime = plugin.capabilityManifest.localServices.length > 0
      ? {
          serviceId,
          title: plugin.capabilityManifest.plugin.name ?? plugin.pluginId,
          requireMcp: Boolean(plugin.capabilityManifest.mcp),
        }
      : undefined;
    for (const capability of plugin.capabilityManifest.skills) {
      const docPath = path.join(plugin.installPath, capability.skillMdPath);
      let raw: string;
      let realpath: string;
      try {
        [raw, realpath] = await Promise.all([
          fsp.readFile(docPath, 'utf-8'),
          fsp.realpath(docPath),
        ]);
      } catch (err) {
        options.onWarn?.(
          `[PersonalPlugin] failed to read enabled plugin skill ${plugin.pluginId}/${capability.id}: ${(err as Error).message}`,
        );
        continue;
      }

      const parsed = parseSkillDoc(raw, { dirName: capability.id, docPath }, options.onWarn);
      if (!parsed) continue;
      const runtime = pluginRuntime && isRuntimeLaunchSkill(parsed, capability.id)
        ? pluginRuntime
        : undefined;
      const slug = parsed.frontmatter.slug;
      const base = {
        source: 'user' as const,
        scope: 'space' as const,
        slug,
        metaSource: 'user' as const,
      };
      skills.push({
        canonicalKey: buildCanonicalKey(base),
        source: 'user',
        scope: 'space',
        spaceId: options.spaceId,
        slug,
        name: parsed.frontmatter.name,
        displayName: parsed.frontmatter.displayName,
        description: parsed.frontmatter.description,
        whenToUse: parsed.frontmatter.when_to_use,
        version: parsed.frontmatter.version,
        docPath,
        realpath,
        content: raw,
        xTabtinApps: parsed.frontmatter['x-tabtin-apps'],
        xTabtinAgents: parsed.frontmatter['x-tabtin-agents'],
        tags: parsed.frontmatter.tags,
        category: parsed.frontmatter.category,
        requires: parsed.frontmatter.requires,
        install: parsed.frontmatter.install,
        osFilter: parsed.frontmatter.os_filter,
        always: parsed.frontmatter.always,
        emoji: parsed.frontmatter.emoji,
        homepage: parsed.frontmatter.homepage,
        agents: parsed.frontmatter.agents,
        primaryEnv: parsed.frontmatter.primary_env,
        rootKind: 'space',
        metaSource: 'user',
        personalPluginId: plugin.pluginId,
        personalPluginName: plugin.capabilityManifest.plugin.id,
        personalPluginDisplayName: plugin.capabilityManifest.plugin.name,
        personalPluginRuntime: runtime,
        indexedAt: Date.now(),
      });
    }
  }

  return {
    enabledPluginIds: enabledPlugins.map((plugin) => plugin.pluginId).sort(),
    skills: skills.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey)),
  };
}
