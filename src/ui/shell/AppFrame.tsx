import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { TESTID } from "../testids";
import { computeColumns } from "./columns";
import css from "./AppFrame.module.css";

export interface AppFrameProps {
  sidebar: ReactNode;
  main: ReactNode;
  sidebarVisible: boolean;
  sidebarWidth: number;
  onSidebarWidthChange(width: number): void;
  /** Renders the right panel; it docks as a third column when the frame has room and overlays the main column otherwise. */
  rightPanel?: ((placement: "docked" | "overlay") => ReactNode) | null;
  /** Requested docked width of the right panel in px; columns.ts clamps it. */
  rightPanelWidth?: number;
}

interface DragHandleProps {
  left: number;
  onStart(): void;
  onDrag(dx: number): void;
  onEnd(): void;
}

function DragHandle(props: DragHandleProps) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  const endDrag = useCallback(() => {
    const active = capture.current;
    if (active === null) return;
    capture.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    setDragging(false);
    callbacks.current.onEnd();
  }, []);
  useEffect(() => endDrag, [endDrag]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || capture.current !== null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    capture.current = { element: e.currentTarget, id: e.pointerId };
    origin.current = e.clientX;
    latest.current = e.clientX;
    callbacks.current.onStart();
    setDragging(true);
  }, []);
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return;
    latest.current = e.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onDrag(latest.current - origin.current);
    });
  }, []);
  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (capture.current?.id !== e.pointerId) return;
      callbacks.current.onDrag(e.clientX - origin.current);
      endDrag();
    },
    [endDrag],
  );
  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (capture.current?.id === e.pointerId) endDrag();
    },
    [endDrag],
  );

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  );
}

/**
 * Shell (sidebar | main | optional right panel) ported from DSH ui-layout AppFrame: grid tracks solved by
 * columns.ts, a pointer-capture drag handle on the sidebar edge, eased tracks only on a
 * show/hide toggle, and macOS window chrome (data-platform, vibrancy sidebar, drag strips).
 */
export function AppFrame({
  sidebar,
  main,
  sidebarVisible,
  sidebarWidth,
  onSidebarWidthChange,
  rightPanel = null,
  rightPanelWidth = 0,
}: AppFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(0);

  useLayoutEffect(() => {
    document.documentElement.dataset["platform"] = window.omo.platform;
  }, []);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (el === null) return;
    let raf: number | null = null;
    let disposed = false;
    const measure = (): void => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setViewport(width);
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      raf ??= requestAnimationFrame(() => {
        raf = null;
        measure();
      });
    });
    observer.observe(el);
    return () => {
      disposed = true;
      observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  const cols = computeColumns(viewport, sidebarVisible ? sidebarWidth : 0, rightPanel === null ? 0 : rightPanelWidth);
  const docked = rightPanel !== null && cols.rightbar > 0;
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const dragBase = useRef(0);
  const [dragging, setDragging] = useState(false);

  const [animating, setAnimating] = useState(0);
  const previousVisible = useRef(sidebarVisible);
  const previousViewport = useRef(viewport);
  useLayoutEffect(() => {
    const viewportChanged = previousViewport.current !== viewport;
    previousViewport.current = viewport;
    if (previousVisible.current === sidebarVisible) return;
    previousVisible.current = sidebarVisible;
    if (viewportChanged) return;
    setAnimating((token) => token + 1);
  }, [sidebarVisible, viewport]);
  useEffect(() => {
    if (animating === 0) return;
    const frame = frameRef.current;
    if (frame === null) return;
    const settle = (): void => setAnimating(0);
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (event.target === frame && event.propertyName === "grid-template-columns") settle();
    };
    frame.addEventListener("transitionend", onTransitionEnd);
    const timer = setTimeout(settle, 600);
    return () => {
      frame.removeEventListener("transitionend", onTransitionEnd);
      clearTimeout(timer);
    };
  }, [animating]);

  const onDragStart = useCallback(() => {
    dragBase.current = colsRef.current.sidebar;
    setDragging(true);
  }, []);
  const onDrag = useCallback((dx: number) => onSidebarWidthChange(dragBase.current + dx), [onSidebarWidthChange]);
  const onDragEnd = useCallback(() => setDragging(false), []);

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0px, 1fr)${docked ? ` ${cols.rightbar}px` : ""}` }}
      data-testid={TESTID.appFrame}
      data-sidebar-collapsed={!sidebarVisible || undefined}
      data-dragging={dragging || undefined}
      data-animating={animating > 0 || undefined}
    >
      <div className={css.sidebarCol}>
        <div className={css.dragStrip} data-window-drag />
        {sidebar}
      </div>
      <div className={css.centerCol}>
        <div className={css.dragStrip} data-window-drag />
        {main}
        {rightPanel !== null && !docked && <div className={css.rightOverlay}>{rightPanel("overlay")}</div>}
      </div>
      {docked && (
        <div className={css.rightCol}>
          <div className={css.dragStrip} data-window-drag />
          {rightPanel("docked")}
        </div>
      )}
      {sidebarVisible && <DragHandle left={cols.sidebar} onStart={onDragStart} onDrag={onDrag} onEnd={onDragEnd} />}
    </div>
  );
}
