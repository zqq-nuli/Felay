/**
 * Markdown → Feishu Post (rich text) converter.
 *
 * Two variants:
 * - markdownToPost():      Full format for IM API (supports style + code_block)
 * - markdownToPostBasic(): Basic format for webhook (text + a tags only)
 */

/* ── Types ── */

interface TextElement {
  tag: "text";
  text: string;
  style?: string[];
}

interface LinkElement {
  tag: "a";
  text: string;
  href: string;
}

interface CodeBlockElement {
  tag: "code_block";
  language: string;
  text: string;
}

type PostElement = TextElement | LinkElement | CodeBlockElement;
type PostParagraph = PostElement[];

interface PostContent {
  zh_cn: {
    title: string;
    content: PostParagraph[];
  };
}

/* ── Constants ── */

const MAX_CONTENT_LENGTH = 28000;

/**
 * Regex to match fenced code blocks: ```lang\ncode\n```
 * Captures: [1] = language (optional), [2] = code content
 */
const CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;

/**
 * Inline format regex (order matters — longer patterns first):
 * [1] = inline code (`...`)
 * [2] = bold (**...**)
 * [3] = italic (*...*)
 * [4] = full link match [text](url)
 * [5] = link text
 * [6] = link url
 */
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[([^\]]+)\]\(([^)]+)\))/g;

/* ── Helpers ── */

/** Parse inline markdown within a single line/paragraph into PostElements (full format). */
function parseInlineFull(text: string): PostElement[] {
  const elements: PostElement[] = [];
  let lastIndex = 0;

  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(text)) !== null) {
    // Plain text before this match
    if (match.index > lastIndex) {
      elements.push({ tag: "text", text: text.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      // Inline code: `code`
      elements.push({
        tag: "text",
        text: match[1].slice(1, -1),
        style: ["code"],
      });
    } else if (match[2]) {
      // Bold: **text**
      elements.push({
        tag: "text",
        text: match[2].slice(2, -2),
        style: ["bold"],
      });
    } else if (match[3]) {
      // Italic: *text*
      elements.push({
        tag: "text",
        text: match[3].slice(1, -1),
        style: ["italic"],
      });
    } else if (match[4]) {
      // Link: [text](url)
      elements.push({
        tag: "a",
        text: match[5],
        href: match[6],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    elements.push({ tag: "text", text: text.slice(lastIndex) });
  }

  return elements;
}

/** Parse inline markdown into PostElements (basic format — no style, text + a only). */
function parseInlineBasic(text: string): PostElement[] {
  const elements: PostElement[] = [];
  let lastIndex = 0;

  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push({ tag: "text", text: text.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      // Inline code → plain text (strip backticks)
      elements.push({ tag: "text", text: match[1].slice(1, -1) });
    } else if (match[2]) {
      // Bold → plain text (strip **)
      elements.push({ tag: "text", text: match[2].slice(2, -2) });
    } else if (match[3]) {
      // Italic → plain text (strip *)
      elements.push({ tag: "text", text: match[3].slice(1, -1) });
    } else if (match[4]) {
      // Link → keep as link tag
      elements.push({ tag: "a", text: match[5], href: match[6] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push({ tag: "text", text: text.slice(lastIndex) });
  }

  return elements;
}

/**
 * Process a block of text (between code blocks) into paragraphs.
 * Splits by double newline for paragraph breaks.
 * Handles heading lines (# ...) and preserves list items as separate paragraphs.
 */
function textBlockToParagraphs(
  text: string,
  parseInline: (t: string) => PostElement[],
  fullMode: boolean
): PostParagraph[] {
  const paragraphs: PostParagraph[] = [];
  // Split by double newline (paragraph breaks)
  const rawParagraphs = text.split(/\n{2,}/);

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Split by single newline to handle line-level features (headings, list items)
    const lines = trimmed.split("\n");
    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed) continue;

      // Heading: strip # prefix, render as bold text
      const headingMatch = lineTrimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        if (fullMode) {
          paragraphs.push([
            { tag: "text", text: headingMatch[2], style: ["bold"] },
          ]);
        } else {
          paragraphs.push([{ tag: "text", text: headingMatch[2] }]);
        }
        continue;
      }

      // Regular line — parse inline formatting
      const elements = parseInline(lineTrimmed);
      if (elements.length > 0) {
        paragraphs.push(elements);
      }
    }
  }

  return paragraphs;
}

/** Truncate markdown input if too long. */
function truncate(md: string): string {
  if (md.length <= MAX_CONTENT_LENGTH) return md;
  return "...(truncated)\n" + md.slice(-MAX_CONTENT_LENGTH);
}

/* ── Public API ── */

/**
 * Convert Markdown text to Feishu post content (full format for IM API).
 * Supports: bold, italic, inline code, code blocks, links.
 */
export function markdownToPost(md: string): PostContent {
  const input = truncate(md.trim());

  if (!input) {
    return { zh_cn: { title: "", content: [[{ tag: "text", text: "" }]] } };
  }

  const paragraphs: PostParagraph[] = [];
  let lastIndex = 0;

  // Extract fenced code blocks
  CODE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_BLOCK_RE.exec(input)) !== null) {
    // Process text before this code block
    const textBefore = input.slice(lastIndex, match.index);
    if (textBefore.trim()) {
      paragraphs.push(...textBlockToParagraphs(textBefore, parseInlineFull, true));
    }

    // Add the code block as its own paragraph
    const language = match[1] || "";
    const code = match[2];
    paragraphs.push([
      { tag: "code_block", language, text: code.replace(/\n$/, "") },
    ]);

    lastIndex = match.index + match[0].length;
  }

  // Process remaining text after last code block
  const textAfter = input.slice(lastIndex);
  if (textAfter.trim()) {
    paragraphs.push(...textBlockToParagraphs(textAfter, parseInlineFull, true));
  }

  // Ensure at least one paragraph
  if (paragraphs.length === 0) {
    paragraphs.push([{ tag: "text", text: input }]);
  }

  return { zh_cn: { title: "", content: paragraphs } };
}

/**
 * Convert Markdown text to Feishu post content (basic format for webhook).
 * Only supports: text and a (link) tags. No style, no code_block.
 */
export function markdownToPostBasic(md: string): PostContent {
  const input = truncate(md.trim());

  if (!input) {
    return { zh_cn: { title: "", content: [[{ tag: "text", text: "" }]] } };
  }

  const paragraphs: PostParagraph[] = [];
  let lastIndex = 0;

  // Extract fenced code blocks — render as plain text paragraphs
  CODE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_BLOCK_RE.exec(input)) !== null) {
    const textBefore = input.slice(lastIndex, match.index);
    if (textBefore.trim()) {
      paragraphs.push(...textBlockToParagraphs(textBefore, parseInlineBasic, false));
    }

    // Code block → plain text paragraph (no code_block tag for webhook)
    const code = match[2].replace(/\n$/, "");
    if (code.trim()) {
      paragraphs.push([{ tag: "text", text: code }]);
    }

    lastIndex = match.index + match[0].length;
  }

  const textAfter = input.slice(lastIndex);
  if (textAfter.trim()) {
    paragraphs.push(...textBlockToParagraphs(textAfter, parseInlineBasic, false));
  }

  if (paragraphs.length === 0) {
    paragraphs.push([{ tag: "text", text: input }]);
  }

  return { zh_cn: { title: "", content: paragraphs } };
}
