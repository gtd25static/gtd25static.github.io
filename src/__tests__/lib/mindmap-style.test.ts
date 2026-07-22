import { describe, expect, it } from 'vitest';
import {
  PALETTES,
  SHAPE_TEXT_MAX_WIDTH,
  diamondPoints,
  hasCustomStyle,
  isHexColor,
  isNodeShape,
  isPaletteId,
  resolveNodeStyle,
  shapeSize,
} from '../../lib/mindmap-style';

describe('validation', () => {
  it('accepts only the three shapes', () => {
    expect(isNodeShape('rect')).toBe(true);
    expect(isNodeShape('circle')).toBe(true);
    expect(isNodeShape('diamond')).toBe(true);
    expect(isNodeShape('triangle')).toBe(false);
    expect(isNodeShape(undefined)).toBe(false);
  });

  it('accepts only known preset ids', () => {
    expect(isPaletteId(PALETTES[0].id)).toBe(true);
    // An unknown id would be interpolated into a CSS var name
    expect(isPaletteId('sky); background: url(x')).toBe(false);
    expect(isPaletteId('__proto__')).toBe(false);
  });

  it('accepts only #rrggbb colours', () => {
    expect(isHexColor('#a1b2c3')).toBe(true);
    expect(isHexColor('#ABCDEF')).toBe(true);
    expect(isHexColor('#abc')).toBe(false);            // shorthand not allowed
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('rgb(1,2,3)')).toBe(false);
    expect(isHexColor('url(javascript:alert(1))')).toBe(false);
    expect(isHexColor('#abcdef; background: red')).toBe(false);
  });
});

describe('resolveNodeStyle', () => {
  it('falls back to the default look, accent-tinted for the root', () => {
    expect(resolveNodeStyle({})).toEqual({
      shape: 'rect',
      bg: 'var(--mm-default-bg)',
      fg: 'var(--mm-default-fg)',
      border: 'var(--mm-default-border)',
    });
    expect(resolveNodeStyle({}, { isRoot: true }).bg).toBe('var(--mm-root-bg)');
  });

  it('maps a preset to its CSS variables so it follows the theme', () => {
    const style = resolveNodeStyle({ palette: 'mint' });
    expect(style).toMatchObject({
      bg: 'var(--mm-mint-bg)',
      fg: 'var(--mm-mint-fg)',
      border: 'var(--mm-mint-border)',
    });
  });

  it('ignores junk stored on the node instead of rendering it', () => {
    const style = resolveNodeStyle({
      shape: 'blob' as never,
      palette: 'evil); content: url(x',
      colorBg: 'red; position: fixed',
    });
    expect(style.shape).toBe('rect');
    expect(style.bg).toBe('var(--mm-default-bg)');
  });

  it('lets per-part colours override the preset', () => {
    const style = resolveNodeStyle({ palette: 'sky', colorFg: '#123456' });
    expect(style.bg).toBe('var(--mm-sky-bg)');
    expect(style.fg).toBe('#123456');
  });

  it('lets a preview override everything, including clearing a colour', () => {
    const node = { palette: 'sky', colorFg: '#123456' };
    expect(resolveNodeStyle(node, { preview: { palette: 'rose' } }).bg).toBe('var(--mm-rose-bg)');
    // A null in the preview means "as if it were unset"
    expect(resolveNodeStyle(node, { preview: { palette: null, colorFg: null } }).fg)
      .toBe('var(--mm-default-fg)');
  });

  it('knows whether a node carries any formatting', () => {
    expect(hasCustomStyle({})).toBe(false);
    expect(hasCustomStyle({ shape: 'circle' })).toBe(true);
    expect(hasCustomStyle({ colorBorder: '#000000' })).toBe(true);
  });
});

describe('shapeSize', () => {
  it('pads a rectangle around its label', () => {
    expect(shapeSize('rect', 100, 20)).toEqual({ w: 128, h: 36 });
  });

  it('gives a circle the label diagonal, and keeps it round', () => {
    const { w, h } = shapeSize('circle', 100, 40);
    expect(w).toBe(h);
    expect(w).toBeGreaterThanOrEqual(Math.hypot(100, 40));
  });

  it('grows a diamond enough to actually contain its label', () => {
    for (const [textW, textH] of [[90, 30], [15, 18], [120, 54], [8, 60]] as const) {
      const { w, h } = shapeSize('diamond', textW, textH);
      // An axis-aligned rect fits in a rhombus while w/W + h/H <= 1
      expect(textW / w + textH / h).toBeLessThanOrEqual(1);
    }
  });

  it('always makes a diamond slightly wider than tall, whatever the label', () => {
    for (const [textW, textH] of [[90, 30], [15, 18], [120, 54], [8, 60], [200, 12]] as const) {
      const { w, h } = shapeSize('diamond', textW, textH);
      expect(w).toBeGreaterThan(h);
      expect(w / h).toBeCloseTo(1.4, 1);
    }
  });

  it('never goes below a minimum side for the round shapes', () => {
    expect(shapeSize('circle', 4, 4).w).toBe(48);
    expect(shapeSize('diamond', 4, 4)).toEqual({ w: 68, h: 48 });
  });

  it('caps label width per shape so round shapes stay usable', () => {
    expect(SHAPE_TEXT_MAX_WIDTH.rect).toBeGreaterThan(SHAPE_TEXT_MAX_WIDTH.circle);
    expect(SHAPE_TEXT_MAX_WIDTH.circle).toBeGreaterThan(SHAPE_TEXT_MAX_WIDTH.diamond);
  });
});

describe('diamondPoints', () => {
  it('spans the box corner to corner', () => {
    expect(diamondPoints(0, 0, 100, 40)).toBe('50,0 100,20 50,40 0,20');
  });
});
