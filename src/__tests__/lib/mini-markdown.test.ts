import { parseMiniMarkdown, parseInline, mdToPlainText } from '../../lib/mini-markdown';

describe('parseInline', () => {
  it('plain text passes through', () => {
    expect(parseInline('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('parses bold', () => {
    expect(parseInline('a **b** c')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'bold', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' c' },
    ]);
  });

  it('parses italic', () => {
    expect(parseInline('*it*')).toEqual([
      { type: 'italic', children: [{ type: 'text', text: 'it' }] },
    ]);
  });

  it('parses code and suppresses inner parsing', () => {
    expect(parseInline('`**not bold**`')).toEqual([
      { type: 'code', text: '**not bold**' },
    ]);
  });

  it('parses links with nested formatting in the text', () => {
    expect(parseInline('[see **docs**](https://example.com)')).toEqual([
      {
        type: 'link',
        href: 'https://example.com',
        children: [
          { type: 'text', text: 'see ' },
          { type: 'bold', children: [{ type: 'text', text: 'docs' }] },
        ],
      },
    ]);
  });

  it('nests bold inside italic', () => {
    expect(parseInline('*a **b***')).toEqual([
      {
        type: 'italic',
        children: [
          { type: 'text', text: 'a ' },
          { type: 'bold', children: [{ type: 'text', text: 'b' }] },
        ],
      },
    ]);
  });

  it('unclosed markers fall back to literal text', () => {
    expect(parseInline('**open')).toEqual([{ type: 'text', text: '**open' }]);
    expect(parseInline('*x')).toEqual([{ type: 'text', text: '*x' }]);
    expect(parseInline('`x')).toEqual([{ type: 'text', text: '`x' }]);
    expect(parseInline('[text](unclosed')).toEqual([{ type: 'text', text: '[text](unclosed' }]);
    expect(parseInline('[]()')).toEqual([{ type: 'text', text: '[]()' }]);
  });

  it('empty emphasis is literal', () => {
    expect(parseInline('****')).toEqual([{ type: 'text', text: '****' }]);
    expect(parseInline('**')).toEqual([{ type: 'text', text: '**' }]);
  });

  it('never throws on pathological input', () => {
    const inputs = ['*'.repeat(999), '[['.repeat(200), '`*`*`*`', '](*)[', '\\**\\*', '*a**b*c**'];
    for (const input of inputs) {
      expect(() => parseInline(input)).not.toThrow();
    }
  });

  it('handles a 1000-char label quickly', () => {
    const label = ('word **bold** `code` [l](https://x.y) ').repeat(25).slice(0, 1000);
    expect(() => parseInline(label)).not.toThrow();
  });
});

describe('parseMiniMarkdown (blocks)', () => {
  it('splits lines into one paragraph', () => {
    const blocks = parseMiniMarkdown('line one\nline two');
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        lines: [
          [{ type: 'text', text: 'line one' }],
          [{ type: 'text', text: 'line two' }],
        ],
      },
    ]);
  });

  it('groups "- " lines into list blocks between paragraphs', () => {
    const blocks = parseMiniMarkdown('intro\n- a\n- b\noutro');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'paragraph']);
    const list = blocks[1] as { type: 'list'; items: unknown[][] };
    expect(list.items).toHaveLength(2);
  });

  it('indented list lines still count as list items', () => {
    const blocks = parseMiniMarkdown('  - indented');
    expect(blocks[0].type).toBe('list');
  });
});

describe('mdToPlainText', () => {
  it('strips markers, keeps text and line structure', () => {
    expect(mdToPlainText('**a** *b* `c` [d](https://x)')).toBe('a b c d');
    expect(mdToPlainText('one\n- two\n- three')).toBe('one\ntwo\nthree');
  });
});
