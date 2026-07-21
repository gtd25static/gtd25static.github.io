// Minimal markdown-subset parser for mindmap node labels. Pure string → token
// tree, no React, no HTML — the renderer (MdLabel) maps tokens to React
// elements, so markup injection through a stored label is impossible by
// construction. Supported: **bold**, *italic*, `code` (suppresses inner
// parsing), [text](url), line breaks, and simple "- " list lines. Anything
// malformed (unclosed markers, stray brackets) falls back to literal text —
// this parser never throws.

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: MdInline[] }
  | { type: 'italic'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdInline[] };

export type MdBlock =
  | { type: 'paragraph'; lines: MdInline[][] }
  | { type: 'list'; items: MdInline[][] };

export function parseMiniMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: MdInline[][] = [];
  let list: MdInline[][] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ type: 'list', items: list });
      list = [];
    }
  };

  for (const line of src.split('\n')) {
    const listMatch = /^\s*-\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      list.push(parseInline(listMatch[1]));
    } else {
      flushList();
      paragraph.push(parseInline(line));
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  let literal = '';
  const pushLiteral = () => {
    if (literal.length > 0) {
      out.push({ type: 'text', text: literal });
      literal = '';
    }
  };

  let i = 0;
  while (i < s.length) {
    if (s.startsWith('**', i)) {
      const close = s.indexOf('**', i + 2);
      if (close > i + 2) {
        pushLiteral();
        out.push({ type: 'bold', children: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    } else if (s[i] === '*') {
      const close = findSingleStar(s, i + 1);
      if (close > i + 1) {
        pushLiteral();
        out.push({ type: 'italic', children: parseInline(s.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    } else if (s[i] === '`') {
      const close = s.indexOf('`', i + 1);
      if (close > i + 1) {
        pushLiteral();
        out.push({ type: 'code', text: s.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    } else if (s[i] === '[') {
      const match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (match) {
        pushLiteral();
        out.push({ type: 'link', href: match[2], children: parseInline(match[1]) });
        i += match[0].length;
        continue;
      }
    }
    literal += s[i];
    i++;
  }
  pushLiteral();
  return out;
}

// The italic closer is the next SINGLE '*' — '**' pairs are skipped so bold
// can nest inside italic ("*a **b** c*").
function findSingleStar(s: string, from: number): number {
  let p = from;
  while (p < s.length) {
    if (s[p] === '*') {
      if (s[p + 1] === '*') { p += 2; continue; }
      return p;
    }
    p++;
  }
  return -1;
}

/** Plain-text version of a label (markers stripped) — used for measuring names, titles, exports. */
export function mdToPlainText(src: string): string {
  const inlineText = (tokens: MdInline[]): string =>
    tokens.map((t) => {
      switch (t.type) {
        case 'text': return t.text;
        case 'code': return t.text;
        case 'bold': return inlineText(t.children);
        case 'italic': return inlineText(t.children);
        case 'link': return inlineText(t.children);
      }
    }).join('');
  return parseMiniMarkdown(src)
    .map((b) => (b.type === 'paragraph' ? b.lines : b.items).map(inlineText).join('\n'))
    .join('\n');
}
