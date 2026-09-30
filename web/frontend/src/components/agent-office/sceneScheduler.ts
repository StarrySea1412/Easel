/** One RAF at a time. Paused/hidden scenes can still request a single repaint. */
export function createSceneScheduler({ request, cancel, draw, animate, visible }: {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
  draw: (time: number) => void;
  animate: () => boolean;
  visible: () => boolean;
}) {
  let frame: number | undefined;
  let disposed = false;
  const invalidate = () => {
    if (disposed || frame !== undefined || !visible()) return;
    frame = request((time) => {
      frame = undefined;
      if (disposed || !visible()) return;
      draw(time);
      if (animate()) invalidate();
    });
  };
  const stop = () => {
    if (frame !== undefined) cancel(frame);
    frame = undefined;
  };
  return {
    invalidate,
    refresh() { stop(); invalidate(); },
    dispose() { disposed = true; stop(); },
  };
}
