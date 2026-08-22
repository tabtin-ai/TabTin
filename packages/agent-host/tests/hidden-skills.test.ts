import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTemporarilyHiddenSkill } from '@tabtin/agent-runtime/skills';
import { TEMPORARILY_HIDDEN_SKILLS } from '../src/capabilities/hidden-skills.js';

describe('TEMPORARILY_HIDDEN_SKILLS', () => {
  it.each([
    'tabsite',
    'tabwhiteboard',
    'tabvideo',
    'tabmail',
    'tabphone',
    'tabinbox',
  ])('隐藏 %s 的 app:<appId>/* skill', (appId) => {
    expect(
      isTemporarilyHiddenSkill(
        {
          canonicalKey: `app:${appId}/operator`,
        },
        TEMPORARILY_HIDDEN_SKILLS,
      ),
    ).toBe(true);
  });

  it.each(['tabslide', 'tabfiles', 'tabcode'])(
    '不隐藏保留 App %s 的 skill',
    (appId) => {
      expect(
        isTemporarilyHiddenSkill(
          {
            canonicalKey: `app:${appId}/operator`,
          },
          TEMPORARILY_HIDDEN_SKILLS,
        ),
      ).toBe(false);
    },
  );
});

describe('#5353 retained Skill prompt content', () => {
  const retainedSkillPromptSources = [
    '../../apps/tabdoc/skills/tabdoc-operator/SKILL.md',
    '../../apps/tabdoc/skills/tabdoc-operator/references/workflow-patterns.md',
    '../../apps/tabtin-office-skills-pack/skills/mail-to-task-followup/SKILL.md',
    '../../apps/tabtin-office-skills-pack/skills/mail-to-task-followup/references/tooling.md',
    '../../apps/tabtin-office-skills-pack/skills/mail-to-task-followup/references/workflow.md',
    '../../apps/tabtin-office-skills-pack/skills/customer-followup-brief/SKILL.md',
    '../../apps/tabtin-office-skills-pack/skills/customer-followup-brief/references/tooling.md',
    '../../apps/tabdesktop/skills/desktop-operator/SKILL.md',
    '../../apps/tabdesktop/skills/desktop-operator/examples/scenarios.md',
  ];

  it.each(retainedSkillPromptSources)(
    'does not reintroduce a hidden App through %s',
    (relativePath) => {
      const content = readFileSync(resolve(__dirname, relativePath), 'utf8');
      expect(content).not.toMatch(
        /\btabsite\b|\btabwhiteboard\b|\btabvideo\b|\btabmail\b|\btabphone\b|\btabinbox\b|\btabtin phone\b/i,
      );
    },
  );
});
