import { describe, it, expect } from 'vitest';
import type { MindmapNode } from '../../db/models';
import {
  branchStyleForSlot,
  nextBranchStyle,
  inheritBranchStyle,
  smartStyleForNewChild,
  type BranchStyle,
} from '../../lib/mindmap-smart-color';

const HEX = /^#[0-9a-f]{6}$/;

function node(o: Partial<MindmapNode> = {}): MindmapNode {
  return { id: 'n', mapId: 'm', order: 0, label: 'x', createdAt: 1, updatedAt: 1, ...o };
}

describe('branchStyleForSlot', () => {
  it('uses the five built-in presets, in order, for the first slots', () => {
    expect(branchStyleForSlot(0)).toEqual({ palette: 'sky' });
    expect(branchStyleForSlot(1)).toEqual({ palette: 'mint' });
    expect(branchStyleForSlot(2)).toEqual({ palette: 'amber' });
    expect(branchStyleForSlot(3)).toEqual({ palette: 'rose' });
    expect(branchStyleForSlot(4)).toEqual({ palette: 'slate' });
  });

  it('synthesises a valid #rrggbb trio (no preset) once presets run out', () => {
    const s = branchStyleForSlot(5);
    expect(s.palette).toBeUndefined();
    expect(s.colorBg).toMatch(HEX);
    expect(s.colorFg).toMatch(HEX);
    expect(s.colorBorder).toMatch(HEX);
  });

  it('gives distinct synthesised colours to consecutive overflow slots', () => {
    expect(branchStyleForSlot(5).colorBg).not.toBe(branchStyleForSlot(6).colorBg);
    expect(branchStyleForSlot(6).colorBg).not.toBe(branchStyleForSlot(7).colorBg);
  });
});

describe('nextBranchStyle', () => {
  it('starts from the first preset for the very first branch', () => {
    expect(nextBranchStyle([])).toEqual({ palette: 'sky' });
  });

  it('picks the first preset not already used by a sibling branch', () => {
    expect(nextBranchStyle([{ palette: 'sky' }, { palette: 'mint' }])).toEqual({ palette: 'amber' });
  });

  it('reuses a colour freed by a deleted branch (no gap-walking)', () => {
    // sky is free again; slot 0 comes back rather than advancing to the next.
    expect(nextBranchStyle([{ palette: 'mint' }])).toEqual({ palette: 'sky' });
  });

  it('overflows to a synthesised colour once all five presets are taken', () => {
    const taken: BranchStyle[] = [
      { palette: 'sky' }, { palette: 'mint' }, { palette: 'amber' },
      { palette: 'rose' }, { palette: 'slate' },
    ];
    const next = nextBranchStyle(taken);
    expect(next.palette).toBeUndefined();
    expect(next.colorBg).toMatch(HEX);
  });

  it('never repeats a colour across many consecutive branches', () => {
    const branches: BranchStyle[] = [];
    const keys = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const style = nextBranchStyle(branches);
      const key = style.palette ?? style.colorBg!;
      expect(keys.has(key)).toBe(false); // each new branch is a fresh colour
      keys.add(key);
      branches.push(style);
    }
    expect(keys.size).toBe(12);
  });
});

describe('inheritBranchStyle', () => {
  it('copies a preset id', () => {
    expect(inheritBranchStyle({ palette: 'rose' })).toEqual({ palette: 'rose' });
  });

  it('copies literal colours when there is no preset', () => {
    expect(inheritBranchStyle({ colorBg: '#112233', colorFg: '#445566', colorBorder: '#778899' }))
      .toEqual({ colorBg: '#112233', colorFg: '#445566', colorBorder: '#778899' });
  });

  it('prefers the preset over any stray literal colours', () => {
    expect(inheritBranchStyle({ palette: 'sky', colorBg: '#112233' })).toEqual({ palette: 'sky' });
  });

  it('yields nothing for an uncoloured parent', () => {
    expect(inheritBranchStyle({})).toEqual({});
  });
});

describe('smartStyleForNewChild', () => {
  const root = node({ id: 'r', parentId: undefined });

  it('opens a NEW distinct branch for a direct child of the root', () => {
    const a = node({ id: 'a', parentId: 'r', palette: 'sky' });
    expect(smartStyleForNewChild(root, [root, a])).toEqual({ palette: 'mint' });
  });

  it('gives the first branch off a fresh root the first preset', () => {
    expect(smartStyleForNewChild(root, [root])).toEqual({ palette: 'sky' });
  });

  it('ignores soft-deleted branches when choosing a colour', () => {
    const dead = node({ id: 'a', parentId: 'r', palette: 'sky', deletedAt: 99 });
    // The only branch is deleted → sky is free again.
    expect(smartStyleForNewChild(root, [root, dead])).toEqual({ palette: 'sky' });
  });

  it('inherits the parent branch colour for a deeper node', () => {
    const branch = node({ id: 'b', parentId: 'r', palette: 'amber' });
    expect(smartStyleForNewChild(branch, [root, branch])).toEqual({ palette: 'amber' });
  });

  it('returns undefined when there is no parent', () => {
    expect(smartStyleForNewChild(undefined, [root])).toBeUndefined();
  });

  it('returns undefined when a non-root parent carries no colour', () => {
    const bare = node({ id: 'b', parentId: 'r' });
    expect(smartStyleForNewChild(bare, [root, bare])).toBeUndefined();
  });
});
