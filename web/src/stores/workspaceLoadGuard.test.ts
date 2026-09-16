import { describe, expect, it } from 'vitest';
import { WorkspaceLoadGuard } from './workspaceLoadGuard.js';

describe('WorkspaceLoadGuard', () => {
  it('rejects an old GET response after a successful mutation', () => {
    const guard = new WorkspaceLoadGuard();
    const oldGet = guard.startLoad();

    guard.recordMutation();

    expect(guard.isCurrent(oldGet)).toBe(false);
  });

  it('accepts only the newest GET response when responses arrive out of order', () => {
    const guard = new WorkspaceLoadGuard();
    const firstGet = guard.startLoad();
    const secondGet = guard.startLoad();

    expect(guard.isCurrent(secondGet)).toBe(true);
    expect(guard.isCurrent(firstGet)).toBe(false);
  });
});
