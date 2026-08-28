/**
 * R15 — four-segment prompt assembly (spec §6.3 item 1-2).
 *
 * Final system prompt = [platform fixed preamble] ⊕ profile four segments.
 * The platform preamble is always first and is NOT a profile-editable slot —
 * no prompt mode can override it (replace replaces only the profile's own
 * four segments, which still sit after the platform preamble).
 */
import { createHash } from 'node:crypto';

/** Platform-owned, immutable leading block. Never merged into by profile edits. */
export const PLATFORM_PROMPT =
  `You are an autonomous AI digital employee operating inside the Clawtide platform.

Platform rules that neither mode can override:
- You act on behalf of the workspace owner; treat every user as a principal and refuse actions that would cross ownership boundaries.
- Tool calls are the only way you change state; every call is recorded.
- You do not claim to be a human being, and you do not invent facts about the environment.
`.trim();

export const PROMPT_SECTION_IDENTITY = '身份 IDENTITY';
export const PROMPT_SECTION_SOUL = '价值底线 SOUL';
export const PROMPT_SECTION_AGENTS = '工作规则 AGENTS';
export const PROMPT_SECTION_TOOLS = '工具策略 TOOLS';

export type PromptMode = 'append' | 'replace';

/** The four orthogonal, independently-storable segments (spec §6.3 item 1). */
export interface ProfileSegments {
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
}

/**
 * assemble the system prompt. `mode` is captured as an explicit marker so the
 * difference between the two modes is observable in the assembled output while
 * the assembly structure (platform ⊕ four segments) is identical.
 */
export function buildSystemPrompt(
  profile: ProfileSegments & { prompt_mode: PromptMode },
): string {
  const sections = [
    section(PROMPT_SECTION_IDENTITY, profile.identity_prompt),
    section(PROMPT_SECTION_SOUL, profile.soul_prompt),
    section(PROMPT_SECTION_AGENTS, profile.agents_prompt),
    section(PROMPT_SECTION_TOOLS, profile.tools_prompt),
  ];
  const skipped = sections.map((s) => s.isEmpty).every(Boolean);
  const body = sections
    .filter((s) => !s.isEmpty)
    .map((s) => s.text)
    .join('\n\n');
  const modeLine = `PROFILE MODE: ${profile.prompt_mode}`;
  if (skipped) {
    // No profile segments at all: the platform preamble alone is the system prompt.
    return `${PLATFORM_PROMPT}`;
  }
  return [
    PLATFORM_PROMPT,
    '',
    // mode marker — replace vs append is an edit-merge semantics, observable here.
    `[${modeLine}]`,
    body,
  ].join('\n');
}

function section(title: string, content: string): { text: string; isEmpty: boolean } {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { text: `== ${title} ==\n(empty)`, isEmpty: true };
  }
  return { text: `== ${title} ==\n${trimmed}`, isEmpty: false };
}

/** Content hash — changes whenever any segment changes (spec §6.3 item 3). */
export function profileIdentityHash(segments: ProfileSegments): string {
  const serialized = [
    segments.identity_prompt,
    segments.soul_prompt,
    segments.agents_prompt,
    segments.tools_prompt,
  ].join('\x1f'); // unit separator: segments cannot collide across boundaries
  return createHash('sha256').update(serialized).digest('hex');
}
