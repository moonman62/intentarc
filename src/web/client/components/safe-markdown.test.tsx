// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SafeMarkdown } from "./safe-markdown.js";

afterEach(cleanup);

describe("SafeMarkdown", () => {
  test("renders only the supported block subset and collision-safe headings", () => {
    const { container } = render(<SafeMarkdown source={`# Overview

First paragraph.

## Overview

- one
- two

| Name | State |
| --- | --- |
| README | Current |

\`\`\`ts
const answer = 42;
\`\`\``} />);

    expect(screen.getAllByRole("heading").map((heading) => heading.id)).toEqual([
      "overview",
      "overview-2",
    ]);
    expect(screen.getByText("First paragraph.").tagName).toBe("P");
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("const answer = 42;").closest("code")?.className).toBe("language-ts");
    expect(container.querySelector("h1#overview")).toBeTruthy();
  });

  test("preserves ordered-list semantics", () => {
    render(<SafeMarkdown source={`1. Inspect
2. Review
3. Accept`} />);

    expect(screen.getByRole("list").tagName).toBe("OL");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Inspect",
      "Review",
      "Accept",
    ]);
  });

  test("reserves heading IDs globally across natural suffix collisions", () => {
    render(<SafeMarkdown source={`# A

# A-2

# A`} />);

    expect(screen.getAllByRole("heading").map((heading) => heading.id)).toEqual([
      "a",
      "a-2",
      "a-3",
    ]);
  });

  test("keeps raw HTML and handlers inert and never creates image requests", () => {
    const { container } = render(
      <SafeMarkdown source={`<img src="https://tracker.invalid/pixel" onerror="steal()">

<script>steal()</script>

![Architecture](https://tracker.invalid/diagram.png)`} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.getByText(/<img src=/).textContent).toContain("onerror");
    expect(screen.getByText(/Attachment: Architecture/).textContent).not.toContain(
      "tracker.invalid",
    );
  });

  test("does not parse Markdown actions inside raw HTML tags or attributes", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<div data-guide="[Attribute](https://attribute.invalid)">[Guide](https://example.com)</div>`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("[Guide](https://example.com)");
    expect(container.textContent).toContain("[Attribute](https://attribute.invalid)");
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("keeps script and style bodies literal across blank lines", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<script>

[Script guide](https://script.invalid)

</script>

<style>
![Tracking](https://tracking.invalid/pixel.png)
[Style guide](https://style.invalid)
</style>`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
    expect(container.textContent).toContain("[Script guide](https://script.invalid)");
    expect(container.textContent).toContain("![Tracking](https://tracking.invalid/pixel.png)");
  });

  test("keeps nested raw HTML blocks literal until the outer close", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<div><div>Nested</div>

[Still raw](https://nested.invalid)

</div>`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("[Still raw](https://nested.invalid)");
  });

  test("conservatively contains namespaced and malformed raw tag blocks", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<x:panel>

[Namespaced](https://namespaced.invalid)

</x:panel>

<div

[Malformed](https://malformed.invalid)

</div>`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("[Namespaced](https://namespaced.invalid)");
    expect(container.textContent).toContain("[Malformed](https://malformed.invalid)");
  });

  test("ignores closing-tag text inside quoted attributes", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<div data-double="</div>">

[Double quoted](https://double.invalid)

</div>

<section data-single='</section>'>

[Single quoted](https://single.invalid)

</section>

[Outside](https://outside.example)`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button", { name: "Open Double quoted externally" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Single quoted externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
    expect(container.textContent).toContain("[Double quoted](https://double.invalid)");
    expect(container.textContent).toContain("[Single quoted](https://single.invalid)");
  });

  test("ignores tag-like text inside comments nested in a raw element", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<div>
<!-- </div> -->

[Still inside](https://comment.invalid)

</div>

[Outside](https://outside.example)`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button", { name: "Open Still inside externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
    expect(container.textContent).toContain("[Still inside](https://comment.invalid)");
  });

  test("contains multiline processing instructions, declarations, and CDATA", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<?intentarc

[PI](https://pi.invalid)

?>

<!DOCTYPE intentarc [

[Declaration](https://declaration.invalid)

]>

<![CDATA[

[CDATA](https://cdata.invalid)

]]>

[Outside](https://outside.example)`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button", { name: "Open PI externally" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Declaration externally" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open CDATA externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
    expect(container.textContent).toContain("[PI](https://pi.invalid)");
    expect(container.textContent).toContain("[Declaration](https://declaration.invalid)");
    expect(container.textContent).toContain("[CDATA](https://cdata.invalid)");
  });

  test("continues parsing ordinary Markdown after a raw range closes", () => {
    const openExternal = vi.fn(async () => undefined);
    render(<SafeMarkdown
      source={`<div>[Raw](https://raw.invalid)</div> [Outside](https://outside.example)`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button", { name: "Open Raw externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
  });

  test("does not accept attributes or self-closing syntax on closing tags", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<div>
</div data-invalid>

[After attributed close](https://attributed.invalid)

</div/>

[After self-closing close](https://self-closing.invalid)

</div>

[Outside](https://outside.example)`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button", { name: "Open After attributed close externally" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open After self-closing close externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
    expect(container.textContent).toContain("[After attributed close](https://attributed.invalid)");
    expect(container.textContent).toContain("[After self-closing close](https://self-closing.invalid)");
  });

  test("does not accept non-HTML whitespace on closing tags", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<div>
</div\u00a0>

[After NBSP close](https://nbsp.invalid)

</div\u000b>

[After vertical-tab close](https://vertical-tab.invalid)

</div>

[Outside](https://outside.example)`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button", { name: "Open After NBSP close externally" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open After vertical-tab close externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
    expect(container.textContent).toContain("[After NBSP close](https://nbsp.invalid)");
    expect(container.textContent).toContain("[After vertical-tab close](https://vertical-tab.invalid)");
  });

  test.each([
    ["space", " "],
    ["tab", "\t"],
    ["line feed", "\n"],
    ["form feed", "\f"],
    ["carriage return", "\r"],
  ])("accepts %s as HTML whitespace on closing tags", (_label, whitespace) => {
    render(<SafeMarkdown
      source={`<div>[Raw](https://raw.invalid)</div${whitespace}> [Outside](https://outside.example)`}
      onOpenExternalHttps={async () => undefined}
    />);

    expect(screen.queryByRole("button", { name: "Open Raw externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
  });

  test("skips processing instructions inside declaration internal subsets", () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = render(<SafeMarkdown
      source={`<!DOCTYPE intentarc [
<?guard ] ?>
[Must stay inert](https://declaration-pi.invalid)
]>

[Outside](https://outside.example)`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("button", { name: "Open Must stay inert externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
    expect(container.textContent).toContain("[Must stay inert](https://declaration-pi.invalid)");
  });

  test("contains deeply nested declarations without using the JavaScript call stack", () => {
    const depth = 12_000;
    const source = `${"<!D[".repeat(depth)}[Nested](https://nested.invalid)${"]>".repeat(depth)}

[Outside](https://outside.example)`;
    expect(source.length).toBeLessThan(200 * 1_024);

    const { container } = render(<SafeMarkdown
      source={source}
      onOpenExternalHttps={async () => undefined}
    />);

    expect(screen.queryByRole("button", { name: "Open Nested externally" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
    expect(container.textContent).toContain("[Nested](https://nested.invalid)");
  });

  test("processes a near-limit void-tag document without repeated suffix joins", () => {
    const tagCount = 256;
    const pad = "x".repeat(3_880);
    const source = [
      ...Array.from({ length: tagCount }, (_value, index) =>
        `<br data-index="${index}" data-pad="${pad}">`),
      "[Outside](https://outside.example)",
    ].join("\n");
    expect(source.length).toBeLessThan(1_048_576);
    let suffixLineWork = 0;
    const originalJoin = Array.prototype.join;
    const joinSpy = vi.spyOn(Array.prototype, "join").mockImplementation(function (
      this: unknown[],
      separator?: string,
    ) {
      if (separator === "\n" && String(this[0] ?? "").startsWith("<br ")) {
        suffixLineWork += this.length;
      }
      return originalJoin.call(this, separator);
    });
    try {
      render(<SafeMarkdown source={source} onOpenExternalHttps={async () => undefined} />);
    } finally {
      joinSpy.mockRestore();
    }

    expect(screen.getByRole("button", { name: "Open Outside externally" })).toBeTruthy();
    expect(screen.getAllByText(/<br data-index=/)).toHaveLength(tagCount);
    expect(suffixLineWork).toBeLessThanOrEqual(tagCount);
  });

  test("makes unsafe and repository links inert and opens HTTPS only by explicit action", () => {
    const openExternal = vi.fn(async () => undefined);
    render(<SafeMarkdown
      source={`[Unsafe](javascript:alert(1)) [Embedded](data:text/html,bad) [Local](../secret.md) [Guide](https://example.com/guide)`}
      onOpenExternalHttps={openExternal}
    />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Unsafe").closest("span")?.dataset.linkState).toBe("blocked");
    expect(screen.getByText("Embedded").closest("span")?.dataset.linkState).toBe("blocked");
    expect(screen.getByText("Local").closest("span")?.dataset.linkState).toBe("repository");
    expect(openExternal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open Guide externally" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/guide");
  });

  test("leaves HTTPS links inert when the desktop action is unavailable", () => {
    render(<SafeMarkdown source="[Guide](https://example.com/guide)" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Guide").closest("span")?.dataset.linkState).toBe("external-unavailable");
  });
});
