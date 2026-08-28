/**
 * R15 — prompt assembly (spec §6.3 必备测试): platform segment always first &
 * unmodifiable, segment order in both modes, identity hash changes with
 * content.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  PLATFORM_PROMPT,
  profileIdentityHash,
  type ProfileSegments,
} from '../prompt-plan.js';

const sample: ProfileSegments = {
  identity_prompt: 'You are a senior e-commerce ops agent.',
  soul_prompt: 'Never fabricate order details.',
  agents_prompt: 'Follow the runbook; escalate on P1.',
  tools_prompt: 'Prefer read-only tools unless authorized.',
};

describe('prompt-plan', () => {
  it('replace mode output begins with the platform segment unchanged', () => {
    const out = buildSystemPrompt({ ...sample, prompt_mode: 'replace' });
    expect(out.startsWith(PLATFORM_PROMPT)).toBe(true);
    // Platform content itself is never rewritten by any mode.
    expect(out.indexOf(PLATFORM_PROMPT)).toBe(0);
  });

  it('append and replace both keep the four-segment order and markers', () => {
    for (const mode of ['append', 'replace'] as const) {
      const out = buildSystemPrompt({ ...sample, prompt_mode: mode });
      const positions = [
        out.indexOf('== 身份 IDENTITY =='),
        out.indexOf('== 价值底线 SOUL =='),
        out.indexOf('== 工作规则 AGENTS =='),
        out.indexOf('== 工具策略 TOOLS =='),
      ];
      expect(positions.every((p) => p > -1)).toBe(true);
      expect(positions[0]! < positions[1]!).toBe(true);
      expect(positions[1]! < positions[2]!).toBe(true);
      expect(positions[2]! < positions[3]!).toBe(true);
      // Mode marker is explicit and observable.
      expect(out).toContain(`PROFILE MODE: ${mode}`);
      // Platform segment still precedes every profile section.
      expect(positions[0]!).toBeGreaterThan(out.indexOf(PLATFORM_PROMPT));
    }
  });

  it('empty profile leaves the platform prompt alone as the system prompt', () => {
    const empty: ProfileSegments = {
      identity_prompt: '',
      soul_prompt: '',
      agents_prompt: '',
      tools_prompt: '',
    };
    expect(buildSystemPrompt({ ...empty, prompt_mode: 'append' })).toBe(PLATFORM_PROMPT);
  });

  it('identity hash changes when any segment changes', () => {
    const h1 = profileIdentityHash(sample);
    const changeSoul = profileIdentityHash({
      ...sample,
      soul_prompt: 'Never fabricate anything.',
    });
    const changeTools = profileIdentityHash({
      ...sample,
      tools_prompt: 'Write-only tool when authorized.',
    });
    expect(h1).not.toBe(changeSoul);
    expect(h1).not.toBe(changeTools);
    expect(changeSoul).not.toBe(changeTools);
  });
});
