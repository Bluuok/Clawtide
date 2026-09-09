import { useRef, useState, type ReactNode } from 'react';
export function ConfirmAction({
  title,
  children,
  onConfirm,
  disabled,
  className,
}: {
  title: string;
  children: ReactNode;
  onConfirm: () => Promise<unknown>;
  disabled?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        disabled={disabled}
        className={className}
        onClick={() => {
          setError(null);
          dialog.current?.showModal();
        }}
      >
        Delete
      </button>
      <dialog ref={dialog} className="confirm-dialog" aria-label={title}>
        <h2>{title}</h2>
        <p>{children}</p>
        {error && <p role="alert">{error}</p>}
        <div className="editor-toolbar">
          <button
            className="rounded-md border border-slate-300 px-4"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className="rounded-md bg-red-700 px-4 text-white"
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                dialog.current?.close();
              } catch {
                setError('Could not delete. Please try again.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </dialog>
    </>
  );
}
export function TideMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M3 12c5-9 9 9 14 0s9 9 12 0M3 20c5-9 9 9 14 0s9 9 12 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    Chat: 'M4 4h16v12H9l-5 4V4z M8 8h8M8 12h5',
    Profiles: 'M5 21v-2a7 7 0 0 1 14 0v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    Tasks: 'M6 4h12v17H6z M9 2h6v4H9z M9 10h6M9 14h6M9 18h3',
    Workspaces: 'M3 6h7l2 2h9v12H3V6z',
    Settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.Chat} />
    </svg>
  );
}
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <TideMark />
      </div>
      <span className="eyebrow">A little room for possibility</span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-art">
        <img
          className="auth-art-image"
          src="/images/tidal-sculpture.png"
          alt=""
          width={1086}
          height={1448}
          fetchPriority="high"
        />
        <div className="brand">
          <TideMark />
          <span>clawtide</span>
        </div>
        <div className="auth-story">
          <span className="eyebrow">Your digital workspace</span>
          <h2>
            Make room for
            <br />
            what matters.
          </h2>
          <p>
            A thoughtful home for your digital workers, conversations, and everyday progress.
          </p>
        </div>
        <span className="auth-caption">CLAWTIDE / A QUIETER WAY TO WORK</span>
      </section>
      <section className="auth-content">
        {children}
        <p className="auth-footnote">Your workspace. Your own pace.</p>
      </section>
    </main>
  );
}
