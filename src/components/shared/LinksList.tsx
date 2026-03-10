import type { TaskLink } from '../../db/models';
import { extractHostname } from '../../lib/link-utils';

interface Props {
  primaryLink?: string;
  primaryTitle?: string;
  links?: TaskLink[];
  maxDisplay?: number;
}

export function LinksList({ primaryLink, primaryTitle, links, maxDisplay = 3 }: Props) {
  const allLinks: { url: string; title?: string }[] = [];
  if (primaryLink) allLinks.push({ url: primaryLink, title: primaryTitle });
  if (links) allLinks.push(...links);

  if (allLinks.length === 0) return null;

  const visible = allLinks.slice(0, maxDisplay);
  const remaining = allLinks.length - maxDisplay;

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      {visible.map((link, i) => (
        <a
          key={i}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-xs text-accent-600 hover:underline dark:text-accent-400"
        >
          {i + 1}. {link.title || extractHostname(link.url)}
        </a>
      ))}
      {remaining > 0 && (
        <span className="text-xs text-zinc-400">+{remaining} more</span>
      )}
    </span>
  );
}
