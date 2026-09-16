import { useCallback, useEffect, useRef, useState } from 'react';

const MOBILE_SIDEBAR_QUERY = '(max-width: 760px)';

export function useMobileSidebar() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryFocusRef = useRef<HTMLElement>(null);
  const pendingFocusRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);

  const close = useCallback((restoreFocus = true) => {
    openRef.current = false;
    setOpen(false);
    if (restoreFocus && window.matchMedia(MOBILE_SIDEBAR_QUERY).matches) {
      requestAnimationFrame(() => toggleRef.current?.focus());
    }
  }, []);

  const openAndFocus = useCallback((target?: HTMLElement | null) => {
    const focusTarget = target ?? primaryFocusRef.current;
    pendingFocusRef.current = focusTarget;
    if (window.matchMedia(MOBILE_SIDEBAR_QUERY).matches) {
      openRef.current = true;
      setOpen(true);
    } else {
      requestAnimationFrame(() => focusTarget?.focus());
    }
  }, []);

  const toggle = useCallback(() => {
    if (open) {
      close();
    } else {
      openAndFocus();
    }
  }, [close, open, openAndFocus]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_SIDEBAR_QUERY);
    // Hiding a focused input can reset activeElement to body before the
    // breakpoint event fires. Remember its focus ownership across that reset.
    let panelHadFocus = panelRef.current?.contains(document.activeElement) ?? false;
    const trackFocus = (event: FocusEvent) => {
      panelHadFocus =
        event.target instanceof Node && !!panelRef.current?.contains(event.target);
    };
    const trackBlur = (event: FocusEvent) => {
      if (event.relatedTarget === null && !media.matches) panelHadFocus = false;
    };
    const onMediaChange = (event: MediaQueryListEvent) => {
      if (!event.matches) {
        close(false);
        return;
      }
      const activeElement = document.activeElement;
      if (
        !openRef.current &&
        (panelRef.current?.contains(activeElement) ||
          (activeElement === document.body && panelHadFocus))
      ) {
        requestAnimationFrame(() => toggleRef.current?.focus());
      }
    };
    document.addEventListener('focusin', trackFocus);
    document.addEventListener('focusout', trackBlur);
    media.addEventListener('change', onMediaChange);
    return () => {
      document.removeEventListener('focusin', trackFocus);
      document.removeEventListener('focusout', trackBlur);
      media.removeEventListener('change', onMediaChange);
    };
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia(MOBILE_SIDEBAR_QUERY);
    const focusFrame = requestAnimationFrame(() => {
      (pendingFocusRef.current ?? primaryFocusRef.current)?.focus();
      pendingFocusRef.current = null;
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (
        media.matches &&
        target instanceof Node &&
        !panelRef.current?.contains(target) &&
        !toggleRef.current?.contains(target)
      ) {
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [close, open]);

  return {
    open,
    close,
    openAndFocus,
    toggle,
    toggleRef,
    panelRef,
    primaryFocusRef,
  };
}
