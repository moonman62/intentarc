import { Fragment, type ReactNode } from "react";

export interface SafeMarkdownProps {
  readonly source: string;
  readonly onOpenExternalHttps?: (url: string) => void | Promise<void>;
}

const inlineTokenPattern = /(!?)\[([^\]\n]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;

const safeHttpsUrl = (candidate: string): string | null => {
  if (!candidate.startsWith("https://")) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      ? parsed.href
      : null;
  } catch {
    return null;
  }
};

const isUnsafeScheme = (target: string): boolean =>
  /^(?:javascript|data|vbscript):/i.test(target.trim());

// Treat an entire inline block as literal when it contains HTML-like syntax.
// This deliberately over-matches rather than allowing Markdown actions to hide
// in tag attributes or raw element bodies.
const containsRawHtml = (text: string): boolean =>
  /<(?:\/?[A-Za-z]|!|\?)/.test(text);

const renderInline = (
  text: string,
  keyPrefix: string,
  onOpenExternalHttps?: (url: string) => void | Promise<void>,
): ReactNode[] => {
  if (containsRawHtml(text)) return [text];
  const result: ReactNode[] = [];
  let offset = 0;
  let match: RegExpExecArray | null;
  inlineTokenPattern.lastIndex = 0;
  while ((match = inlineTokenPattern.exec(text)) !== null) {
    if (match.index > offset) result.push(text.slice(offset, match.index));
    const [token, imageMarker, label, target] = match as unknown as [string, string, string, string];
    const key = `${keyPrefix}-${match.index}`;
    if (imageMarker === "!") {
      result.push(
        <span key={key} className="safe-markdown__attachment" data-attachment-state="metadata">
          Attachment: {label}
        </span>,
      );
    } else {
      const httpsUrl = safeHttpsUrl(target);
      if (httpsUrl !== null && onOpenExternalHttps !== undefined) {
        result.push(
          <button
            key={key}
            type="button"
            className="safe-markdown__external-link"
            aria-label={`Open ${label} externally`}
            onClick={() => {
              void Promise.resolve(onOpenExternalHttps(httpsUrl)).catch(() => undefined);
            }}
          >
            {label}
          </button>,
        );
      } else {
        result.push(
          <span
            key={key}
            className="safe-markdown__inert-link"
            data-link-state={isUnsafeScheme(target)
              ? "blocked"
              : httpsUrl !== null
                ? "external-unavailable"
                : "repository"}
          >
            {label}
          </span>,
        );
      }
    }
    offset = match.index + token.length;
  }
  if (offset < text.length) result.push(text.slice(offset));
  return result;
};

const headingSlug = (text: string): string => {
  const normalized = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "section";
};

const tableCells = (line: string): string[] => line
  .trim()
  .replace(/^\||\|$/g, "")
  .split("|")
  .map((cell) => cell.trim());

const tableSeparator = (line: string): boolean => {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

const isRawHtmlLineStart = (line: string): boolean =>
  /^\s*<(?:\/?[A-Za-z]|!|\?)/.test(line);

const isBlockStart = (lines: readonly string[], index: number): boolean => {
  const line = lines[index] ?? "";
  if (/^\s*$/.test(line)) return true;
  if (/^```/.test(line) || /^ {0,3}#{1,6}\s+/.test(line)) return true;
  if (/^\s*(?:[-+*]|\d+\.)\s+/.test(line)) return true;
  if (isRawHtmlLineStart(line)) return true;
  return line.includes("|") && tableSeparator(lines[index + 1] ?? "");
};

const voidHtmlTags = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

interface ScannedHtmlTag {
  readonly name: string;
  readonly closing: boolean;
  readonly validClosing: boolean;
  readonly selfClosing: boolean;
  readonly complete: boolean;
  readonly end: number;
}

const isHtmlWhitespace = (character: string | undefined): boolean =>
  character === " "
  || character === "\t"
  || character === "\n"
  || character === "\f"
  || character === "\r";

const trimHtmlWhitespaceEnd = (value: string): string => {
  let end = value.length;
  while (end > 0 && isHtmlWhitespace(value[end - 1])) end -= 1;
  return value.slice(0, end);
};

const scanHtmlTag = (source: string, start: number): ScannedHtmlTag | null => {
  if (source[start] !== "<") return null;
  let index = start + 1;
  const closing = source[index] === "/";
  if (closing) index += 1;
  if (!/[A-Za-z]/.test(source[index] ?? "")) return null;
  const nameStart = index;
  while (/[A-Za-z0-9:-]/.test(source[index] ?? "")) index += 1;
  const nameEnd = index;
  const name = source.slice(nameStart, index).toLowerCase();
  const postNameCharacter = source[index];
  if (!isHtmlWhitespace(postNameCharacter) && postNameCharacter !== "/" && postNameCharacter !== ">") {
    if (index !== source.length) return null;
  }
  let quote: "\"" | "'" | null = null;
  for (; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      const postName = source.slice(nameEnd, index);
      const beforeClose = trimHtmlWhitespaceEnd(postName);
      return {
        name,
        closing,
        validClosing: !closing || Array.from(postName).every(isHtmlWhitespace),
        selfClosing: !closing && beforeClose.endsWith("/"),
        complete: true,
        end: index + 1,
      };
    }
  }
  return {
    name,
    closing,
    validClosing: false,
    selfClosing: false,
    complete: false,
    end: source.length,
  };
};

const scanQuotedTerminator = (
  source: string,
  start: number,
  terminator: string,
): number => {
  let quote: "\"" | "'" | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (source.startsWith(terminator, index)) return index + terminator.length;
  }
  return source.length;
};

const scanNonDeclarationSpecialHtmlRange = (
  source: string,
  start: number,
): number | null => {
  if (source.startsWith("<!--", start)) {
    const end = source.indexOf("-->", start + 4);
    return end < 0 ? source.length : end + 3;
  }
  if (source.slice(start, start + 9).toUpperCase() === "<![CDATA[") {
    const end = source.indexOf("]]>", start + 9);
    return end < 0 ? source.length : end + 3;
  }
  if (source.startsWith("<?", start)) {
    return scanQuotedTerminator(source, start + 2, "?>");
  }
  return null;
};

const scanDeclaration = (source: string, start: number): number => {
  interface DeclarationFrame {
    quote: "\"" | "'" | null;
    bracketDepth: number;
  }

  const frames: DeclarationFrame[] = [{ quote: null, bracketDepth: 0 }];
  let index = start + 2;
  while (index < source.length) {
    const frame = frames[frames.length - 1]!;
    const character = source[index]!;
    if (frame.quote !== null) {
      if (character === frame.quote) frame.quote = null;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'") {
      frame.quote = character;
      index += 1;
      continue;
    }
    if (character === "<") {
      const specialEnd = scanNonDeclarationSpecialHtmlRange(source, index);
      if (specialEnd !== null) {
        if (specialEnd >= source.length) return source.length;
        index = specialEnd;
        continue;
      }
      if (source.startsWith("<!", index)) {
        frames.push({ quote: null, bracketDepth: 0 });
        index += 2;
        continue;
      }
    }
    if (character === "[") {
      frame.bracketDepth += 1;
    } else if (character === "]" && frame.bracketDepth > 0) {
      frame.bracketDepth -= 1;
    } else if (character === ">" && frame.bracketDepth === 0) {
      frames.pop();
      index += 1;
      if (frames.length === 0) return index;
      continue;
    }
    index += 1;
  }
  return source.length;
};

const scanSpecialHtmlRange = (source: string, start: number): number | null => {
  const nonDeclarationEnd = scanNonDeclarationSpecialHtmlRange(source, start);
  if (nonDeclarationEnd !== null) return nonDeclarationEnd;
  if (source.startsWith("<!", start)) return scanDeclaration(source, start);
  return null;
};

const rawBlockResult = (
  source: string,
  lines: readonly string[],
  lineOffsets: readonly number[],
  startIndex: number,
  end: number,
): {
  readonly text: string;
  readonly trailingText: string;
  readonly nextIndex: number;
} => {
  const blockStart = lineOffsets[startIndex]!;
  let nextIndex = startIndex + 1;
  while (nextIndex < lines.length && lineOffsets[nextIndex]! < end) {
    nextIndex += 1;
  }
  const lineEnd = source.indexOf("\n", end);
  return {
    text: source.slice(blockStart, end),
    trailingText: source.slice(end, lineEnd < 0 ? source.length : lineEnd),
    nextIndex,
  };
};

const rawHtmlBlock = (
  source: string,
  lines: readonly string[],
  lineOffsets: readonly number[],
  startIndex: number,
): {
  readonly text: string;
  readonly trailingText: string;
  readonly nextIndex: number;
} | null => {
  const blockStart = lineOffsets[startIndex]!;
  let start = blockStart;
  while (source[start] === " " || source[start] === "\t") start += 1;
  const specialEnd = scanSpecialHtmlRange(source, start);
  if (specialEnd !== null) {
    return rawBlockResult(source, lines, lineOffsets, startIndex, specialEnd);
  }

  const outer = scanHtmlTag(source, start);
  if (outer === null || outer.closing) return null;
  if (!outer.complete) {
    return rawBlockResult(source, lines, lineOffsets, startIndex, source.length);
  }
  if (outer.selfClosing || voidHtmlTags.has(outer.name)) {
    return rawBlockResult(source, lines, lineOffsets, startIndex, outer.end);
  }

  let depth = 1;
  let index = outer.end;
  while (depth > 0 && index < source.length) {
    const nextTag = source.indexOf("<", index);
    if (nextTag < 0) return rawBlockResult(
      source,
      lines,
      lineOffsets,
      startIndex,
      source.length,
    );
    const specialRangeEnd = scanSpecialHtmlRange(source, nextTag);
    if (specialRangeEnd !== null) {
      index = specialRangeEnd;
      continue;
    }
    const tag = scanHtmlTag(source, nextTag);
    if (tag === null) {
      index = nextTag + 1;
      continue;
    }
    if (tag.name === outer.name) {
      if (tag.closing) {
        if (tag.validClosing) depth -= 1;
      } else if (!tag.selfClosing) {
        depth += 1;
      }
    }
    index = tag.end;
  }
  return rawBlockResult(source, lines, lineOffsets, startIndex, index);
};

export function SafeMarkdown({ source, onOpenExternalHttps }: SafeMarkdownProps) {
  const normalizedSource = source.replace(/\r\n?/g, "\n");
  const lines = normalizedSource.split("\n");
  const lineOffsets: number[] = [];
  let sourceOffset = 0;
  for (const line of lines) {
    lineOffsets.push(sourceOffset);
    sourceOffset += line.length + 1;
  }
  const nodes: ReactNode[] = [];
  const usedHeadingIds = new Set<string>();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }

    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        content.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1] ?? "";
      nodes.push(
        <pre key={`code-${index}`}>
          <code className={language === "" ? undefined : `language-${language}`}>
            {content.join("\n")}
          </code>
        </pre>,
      );
      continue;
    }

    const rawHtml = rawHtmlBlock(normalizedSource, lines, lineOffsets, index);
    if (rawHtml !== null) {
      nodes.push(
        <pre key={`raw-html-${index}`} className="safe-markdown__raw-html">
          {rawHtml.text}
        </pre>,
      );
      if (rawHtml.trailingText.trim() !== "") {
        nodes.push(
          <p key={`raw-html-trailing-${index}`}>
            {renderInline(
              rawHtml.trailingText.trimStart(),
              `raw-html-trailing-${index}`,
              onOpenExternalHttps,
            )}
          </p>,
        );
      }
      index = rawHtml.nextIndex;
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      const base = headingSlug(text);
      let id = base;
      let suffix = 2;
      while (usedHeadingIds.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      usedHeadingIds.add(id);
      const children = renderInline(text, `heading-${index}`, onOpenExternalHttps);
      if (level === 1) nodes.push(<h1 key={index} id={id}>{children}</h1>);
      else if (level === 2) nodes.push(<h2 key={index} id={id}>{children}</h2>);
      else if (level === 3) nodes.push(<h3 key={index} id={id}>{children}</h3>);
      else if (level === 4) nodes.push(<h4 key={index} id={id}>{children}</h4>);
      else if (level === 5) nodes.push(<h5 key={index} id={id}>{children}</h5>);
      else nodes.push(<h6 key={index} id={id}>{children}</h6>);
      index += 1;
      continue;
    }

    if (line.includes("|") && tableSeparator(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      const body: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && !/^\s*$/.test(lines[index] ?? "")) {
        body.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      nodes.push(
        <div key={`table-${index}`} className="safe-markdown__table-scroll">
          <table>
            <thead><tr>{headers.map((cell, cellIndex) => (
              <th key={cellIndex} scope="col">{renderInline(cell, `th-${index}-${cellIndex}`, onOpenExternalHttps)}</th>
            ))}</tr></thead>
            <tbody>{body.map((row, rowIndex) => (
              <tr key={rowIndex}>{headers.map((_header, cellIndex) => (
                <td key={cellIndex}>{renderInline(row[cellIndex] ?? "", `td-${index}-${rowIndex}-${cellIndex}`, onOpenExternalHttps)}</td>
              ))}</tr>
            ))}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const list = /^\s*((?:[-+*])|(?:\d+\.))\s+(.+)$/.exec(line);
    if (list) {
      const ordered = /\d+\./.test(list[1]!);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*((?:[-+*])|(?:\d+\.))\s+(.+)$/.exec(lines[index] ?? "");
        if (!item || /\d+\./.test(item[1]!) !== ordered) break;
        items.push(item[2]!);
        index += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={itemIndex}>{renderInline(item, `li-${index}-${itemIndex}`, onOpenExternalHttps)}</li>
      ));
      nodes.push(ordered
        ? <ol key={`list-${index}`}>{children}</ol>
        : <ul key={`list-${index}`}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    nodes.push(
      <p key={`paragraph-${index}`}>
        {renderInline(paragraph.join("\n"), `paragraph-${index}`, onOpenExternalHttps)}
      </p>,
    );
  }

  return <div className="safe-markdown">{nodes.map((node, nodeIndex) => <Fragment key={nodeIndex}>{node}</Fragment>)}</div>;
}
