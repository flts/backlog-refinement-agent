import { describe, expect, it } from "vitest";
import {
  applySectionUpdates,
  conformToTemplate,
  diffDocuments,
  parseChecklistSections,
  updateChecklistLine,
} from "./document";

const doc = "## Summary\nOld\n\n## Assumptions\n- [x] Kept\n- [ ] Maybe\n\n## Open questions\n- [ ] Who?";

describe("document helpers", () => {
  it("only changes mentioned sections and keeps confirmed items", () => {
    const { document, warnings } = applySectionUpdates(doc, [
      { heading: "summary", markdown: "New", mode: "replace" },
      { heading: "Assumptions", markdown: "- [ ] Other", mode: "replace" },
    ]);
    expect(document).toContain("## Summary\nNew");
    expect(document).toContain("- [x] Kept");
    expect(document).not.toContain("Maybe");
    expect(document).toContain("## Open questions\n- [ ] Who?");
    expect(warnings).toHaveLength(1);
  });

  it("appends without duplicating lines and adds new sections", () => {
    const { document } = applySectionUpdates(doc, [
      { heading: "Open questions", markdown: "- [ ] Who?\n- [ ] When?", mode: "append" },
      { heading: "Risks", markdown: "None", mode: "replace" },
    ]);
    expect(document.match(/Who\?/g)).toHaveLength(1);
    expect(document).toContain("- [ ] When?");
    expect(document).toContain("## Risks\nNone");
  });

  it("parses and updates checklist items in Assumptions and Open questions sections", () => {
    const entries = parseChecklistSections(doc);
    expect(entries.map(({ kind, text, checked }) => [kind, text, checked])).toEqual([
      ["assumption", "Kept", true], ["assumption", "Maybe", false], ["question", "Who?", false],
    ]);
    expect(updateChecklistLine(doc, entries[1].line, "check")).toContain("- [x] Maybe");
    expect(updateChecklistLine(doc, entries[1].line, "remove")).not.toContain("Maybe");
  });

  it("diffs documents by line", () => {
    expect(diffDocuments("a\nb", "a\nc")).toEqual({ added: ["c"], removed: ["b"] });
  });

  it("conforms a document to the template headings", () => {
    const template = "# T\n\n## Summary\n<!-- hint -->\n\n## Scope\n<!-- hint -->\n\n## Assumptions\n- [ ] ";
    const { document, extraHeadings } = conformToTemplate(
      template,
      "## assumptions\n- [ ] A\n\n## Summary\nS\n\n## My own\nExtra",
    );
    expect(document).toBe("## Summary\nS\n\n## Scope\n\n## Assumptions\n- [ ] A\n\n## Additional notes\n### My own\nExtra");
    expect(extraHeadings).toEqual(["My own"]);
    expect(document).not.toContain("<!--");
  });

  it("matches renamed question/assumption sections and merges them into the template lists", () => {
    const template = "## Summary\n\n## Assumptions\n- [ ] \n\n## Open questions\n- [ ] ";
    const { document, extraHeadings } = conformToTemplate(
      template,
      "## Summary\nS\n\n## Open questions (new)\n- [ ] Q1\n\n## Open Vragen\n- [ ] Q2\n\n## Notes\nN",
    );
    expect(document).toContain("## Open questions\n- [ ] Q1\n- [ ] Q2");
    expect(document).toContain("## Additional notes\n### Notes\nN");
    expect(extraHeadings).toEqual(["Notes"]);
  });
});
