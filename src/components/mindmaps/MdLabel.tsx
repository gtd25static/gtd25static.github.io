import { memo } from 'react';
import { parseMiniMarkdown, type MdInline } from '../../lib/mini-markdown';
import { isValidUrl } from '../../lib/link-utils';

// Renders a node label's markdown subset as React elements — never HTML strings,
// so a synced label cannot inject markup (see THREAT_MODEL.md → Mindmaps).
// The only sanitized surface is link hrefs: http/https only, else plain text.

function InlineTokens({ tokens }: { tokens: MdInline[] }) {
  return (
    <>
      {tokens.map((t, i) => {
        switch (t.type) {
          case 'text':
            return t.text;
          case 'bold':
            return <strong key={i}><InlineTokens tokens={t.children} /></strong>;
          case 'italic':
            return <em key={i}><InlineTokens tokens={t.children} /></em>;
          case 'code':
            return (
              <code key={i} className="rounded bg-zinc-100 px-1 font-mono text-[0.85em] dark:bg-zinc-700">
                {t.text}
              </code>
            );
          case 'link': {
            if (!isValidUrl(t.href)) {
              return <span key={i}><InlineTokens tokens={t.children} /></span>;
            }
            return (
              <a
                key={i}
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-600 underline decoration-accent-300 hover:decoration-accent-600 dark:text-accent-400"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <InlineTokens tokens={t.children} />
              </a>
            );
          }
        }
      })}
    </>
  );
}

export const MdLabel = memo(function MdLabel({ label }: { label: string }) {
  const blocks = parseMiniMarkdown(label);
  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'paragraph' ? (
          <p key={i} className="m-0">
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <InlineTokens tokens={line} />
              </span>
            ))}
          </p>
        ) : (
          <ul key={i} className="m-0 list-disc pl-4">
            {block.items.map((item, j) => (
              <li key={j}><InlineTokens tokens={item} /></li>
            ))}
          </ul>
        ),
      )}
    </>
  );
});
