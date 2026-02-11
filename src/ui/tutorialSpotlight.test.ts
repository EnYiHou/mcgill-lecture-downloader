import { describe, expect, it } from 'vitest';
import { buildTutorialSpotlightPanels } from './tutorialSpotlight';

describe('buildTutorialSpotlightPanels', () => {
  it('builds four surrounding panels for a centered focus rect', () => {
    const panels = buildTutorialSpotlightPanels(
      { left: 40, top: 30, width: 20, height: 10 },
      { width: 100, height: 100 },
      { padding: 5 }
    );

    expect(panels.focus).toEqual({ left: 35, top: 25, width: 30, height: 20 });
    expect(panels.top).toEqual({ left: 0, top: 0, width: 100, height: 25 });
    expect(panels.right).toEqual({ left: 65, top: 25, width: 35, height: 20 });
    expect(panels.bottom).toEqual({ left: 0, top: 45, width: 100, height: 55 });
    expect(panels.left).toEqual({ left: 0, top: 25, width: 35, height: 20 });
  });

  it('clamps focus and panels when target is near viewport edges', () => {
    const panels = buildTutorialSpotlightPanels(
      { left: 2, top: 3, width: 8, height: 7 },
      { width: 100, height: 100 },
      { padding: 10 }
    );

    expect(panels.focus).toEqual({ left: 0, top: 0, width: 20, height: 20 });
    expect(panels.top.height).toBe(0);
    expect(panels.left.width).toBe(0);
    expect(panels.right).toEqual({ left: 20, top: 0, width: 80, height: 20 });
    expect(panels.bottom).toEqual({ left: 0, top: 20, width: 100, height: 80 });
  });

  it('never returns negative dimensions for oversized targets', () => {
    const panels = buildTutorialSpotlightPanels(
      { left: -50, top: -50, width: 300, height: 300 },
      { width: 120, height: 90 },
      { padding: 10 }
    );

    const rectangles = [panels.focus, panels.top, panels.right, panels.bottom, panels.left];
    rectangles.forEach((rect) => {
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
    });

    expect(panels.focus).toEqual({ left: 0, top: 0, width: 120, height: 90 });
    expect(panels.top.height).toBe(0);
    expect(panels.right.width).toBe(0);
    expect(panels.bottom.height).toBe(0);
    expect(panels.left.width).toBe(0);
  });
});
