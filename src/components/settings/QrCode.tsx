import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * A QR code as an SVG path: always black on white with a quiet zone (also in
 * dark mode, where an inverted code reads badly), crisp at any size.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 3 });
    let d = '';
    qr.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
    return { size: qr.size, path: d };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="mx-auto block aspect-square w-full max-w-72 rounded-md"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
