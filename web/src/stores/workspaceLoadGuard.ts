export interface WorkspaceLoadToken {
  requestId: number;
  mutationVersion: number;
}

/**
 * Prevents an earlier list response from replacing state updated by a later
 * mutation, even if a caller accidentally allows the requests to overlap.
 */
export class WorkspaceLoadGuard {
  private requestId = 0;
  private mutationVersion = 0;

  startLoad(): WorkspaceLoadToken {
    return {
      requestId: ++this.requestId,
      mutationVersion: this.mutationVersion,
    };
  }

  recordMutation(): void {
    this.mutationVersion += 1;
  }

  isCurrent(token: WorkspaceLoadToken): boolean {
    return token.requestId === this.requestId && token.mutationVersion === this.mutationVersion;
  }
}
