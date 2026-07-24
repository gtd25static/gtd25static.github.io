// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import '../setup-component';
import { vi, describe, it, expect } from 'vitest';

// The always-visible top banners used to render task titles with no redact
// marker, so shoulder-surfing mode blurred the lists but left the reminders
// legible — the most readable part of the screen. Guard every one of them.

const dueSoon = [
  { type: 'task' as const, id: 'd1', taskId: 't1', title: 'Due secret', dueDate: Date.now() - 86_400_000 },
];
const blocked = [
  { id: 'b1', listId: 'l1', title: 'Blocked secret', reason: 'manual' as const, blockedSubtaskCount: 0 },
];
const followUps = [
  { taskId: 'f1', listId: 'l1', listName: 'People', title: 'Follow-up secret' },
];

vi.mock('../../hooks/use-due-soon', () => ({ useDueSoon: () => dueSoon }));
vi.mock('../../hooks/use-blocked', () => ({ useBlocked: () => blocked }));
vi.mock('../../hooks/use-ready-follow-ups', () => ({ useReadyFollowUps: () => followUps }));
vi.mock('../../hooks/use-motivation', () => ({ useMotivation: () => null }));

import { TopBanner } from '../../components/banners/TopBanner';
import { DueSoonBanner } from '../../components/banners/DueSoonBanner';
import { BlockedBanner } from '../../components/banners/BlockedBanner';
import { FollowUpsReadyBanner } from '../../components/banners/FollowUpsReadyBanner';

/** Redact mode blurs `[data-redact]`; being inside one counts as covered. */
function isRedacted(el: HTMLElement): boolean {
  return el.closest('[data-redact]') !== null;
}

describe('redact-mode coverage of the always-visible banners', () => {
  it('the Due soon banner stack hides task titles', () => {
    render(<TopBanner />);
    expect(isRedacted(screen.getByText(/Due secret/))).toBe(true);
    // The urgency chrome around it is not content and stays readable.
    expect(isRedacted(screen.getByText('Overdue:'))).toBe(false);
  });

  it('the standalone Due soon banner hides task titles', () => {
    render(<DueSoonBanner />);
    expect(isRedacted(screen.getByText(/Due secret/))).toBe(true);
  });

  it('the Blocked banner hides task titles', () => {
    render(<BlockedBanner />);
    expect(isRedacted(screen.getByText(/Blocked secret/))).toBe(true);
    expect(isRedacted(screen.getByText('Blocked'))).toBe(false);
  });

  it('the Ready-to-discuss banner hides follow-up titles', () => {
    render(<FollowUpsReadyBanner />);
    expect(isRedacted(screen.getByText(/Follow-up secret/))).toBe(true);
  });
});
