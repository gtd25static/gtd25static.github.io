import { createElement, useLayoutEffect, useRef, useState } from 'react';

interface Props {
  text: string;
  /** Lines shown while collapsed. */
  clamp?: number;
  className?: string;
  /** Tooltip shown when the text does NOT overflow (so edit hints survive). */
  title?: string;
  as?: 'span' | 'p';
  onDoubleClick?: (e: React.MouseEvent) => void;
}

/**
 * Text that clamps to `clamp` lines and, *only when it actually overflows*,
 * becomes click-to-expand for easier reading. When there's nothing to expand it
 * stays inert and lets the click bubble (so card-level click handlers still
 * work); when expandable it stops propagation and toggles. `onDoubleClick` is
 * forwarded so an inline-edit affordance on the same element keeps working.
 */
export function ExpandableText({ text, clamp = 3, className = '', title, as = 'span', onDoubleClick }: Props) {
  const ref = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  function measure() {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }

  // Measure against the clamped box. While expanded we skip it so `overflowing`
  // stays true and the text remains collapsible.
  useLayoutEffect(() => {
    if (!expanded) measure();
  }, [text, clamp, expanded]);

  // Re-measure when the card resizes (e.g. sidebar toggle, window resize).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (!expanded) measure(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  const clampStyle: React.CSSProperties | undefined = expanded
    ? undefined
    : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: String(clamp), overflow: 'hidden' };

  function handleClick(e: React.MouseEvent) {
    if (!overflowing) return; // nothing to expand — let the click reach the card
    e.stopPropagation();
    setExpanded((v) => !v);
  }

  return createElement(
    as,
    {
      ref,
      style: clampStyle,
      className: `${className}${overflowing ? ' cursor-pointer' : ''}`,
      title: overflowing ? (expanded ? 'Click to collapse' : 'Click to expand') : title,
      onClick: handleClick,
      onDoubleClick,
    },
    text,
  );
}
