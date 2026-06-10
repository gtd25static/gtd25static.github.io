// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../__tests__/setup-component';
import { PasswordStrengthBar } from '../../components/ui/PasswordStrengthBar';

describe('PasswordStrengthBar', () => {
  it('renders nothing for an empty secret', () => {
    const { container } = render(<PasswordStrengthBar secret="" kind="vault" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a red bar and an actionable hint for a very weak secret', () => {
    render(<PasswordStrengthBar secret="abc" kind="vault" />);
    const bar = screen.getByRole('progressbar', { name: 'Secret strength' });
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThan(50);
    expect(bar.querySelector('.bg-red-500')).not.toBeNull();
    expect(screen.getByText(/Crackable instantly/)).toBeInTheDocument();
  });

  it('shows the word hint and an amber bar for a two-word secret', () => {
    render(<PasswordStrengthBar secret="sunshine dolphin sky" kind="vault" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.querySelector('.bg-amber-500')).not.toBeNull();
    expect(screen.getByText(/Make it longer|One or two words/)).toBeInTheDocument();
  });

  it('shows minimal green feedback once the threshold is reached', () => {
    render(<PasswordStrengthBar secret="alpha rhino cactus velvet moon" kind="vault" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.querySelector('.bg-green-500')).not.toBeNull();
    expect(screen.getByText('Strong enough')).toBeInTheDocument();
    expect(screen.queryByText(/Crackable/)).not.toBeInTheDocument();
  });

  it('holds sync secrets to the higher (PBKDF2) threshold', () => {
    // ~53 bits: over the vault line, under the sync line
    const secret = '5162943870516294';
    render(<PasswordStrengthBar secret={secret} kind="sync" />);
    expect(screen.getByText(/Crackable/)).toBeInTheDocument();
  });
});
