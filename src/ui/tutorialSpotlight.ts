export interface SpotlightViewport {
  width: number;
  height: number;
}

export interface SpotlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SpotlightPanels {
  focus: SpotlightRect;
  top: SpotlightRect;
  right: SpotlightRect;
  bottom: SpotlightRect;
  left: SpotlightRect;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeFocusRect(input: SpotlightRect, viewport: SpotlightViewport, padding: number): SpotlightRect {
  const safeWidth = clampNonNegative(viewport.width);
  const safeHeight = clampNonNegative(viewport.height);
  const safePadding = clampNonNegative(padding);
  const left = clamp(input.left - safePadding, 0, safeWidth);
  const top = clamp(input.top - safePadding, 0, safeHeight);
  const right = clamp(input.left + input.width + safePadding, 0, safeWidth);
  const bottom = clamp(input.top + input.height + safePadding, 0, safeHeight);

  return {
    left,
    top,
    width: clampNonNegative(right - left),
    height: clampNonNegative(bottom - top)
  };
}

export function buildTutorialSpotlightPanels(
  targetRect: SpotlightRect,
  viewport: SpotlightViewport,
  options?: { padding?: number }
): SpotlightPanels {
  const focus = normalizeFocusRect(targetRect, viewport, options?.padding ?? 10);
  const viewportWidth = clampNonNegative(viewport.width);
  const viewportHeight = clampNonNegative(viewport.height);
  const focusRight = focus.left + focus.width;
  const focusBottom = focus.top + focus.height;

  return {
    focus,
    top: {
      left: 0,
      top: 0,
      width: viewportWidth,
      height: clampNonNegative(focus.top)
    },
    right: {
      left: clamp(focusRight, 0, viewportWidth),
      top: clamp(focus.top, 0, viewportHeight),
      width: clampNonNegative(viewportWidth - focusRight),
      height: clampNonNegative(focus.height)
    },
    bottom: {
      left: 0,
      top: clamp(focusBottom, 0, viewportHeight),
      width: viewportWidth,
      height: clampNonNegative(viewportHeight - focusBottom)
    },
    left: {
      left: 0,
      top: clamp(focus.top, 0, viewportHeight),
      width: clampNonNegative(focus.left),
      height: clampNonNegative(focus.height)
    }
  };
}
