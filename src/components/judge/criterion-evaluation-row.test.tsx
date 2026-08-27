import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CriterionEvaluationRow } from "./criterion-evaluation-row";

describe("CriterionEvaluationRow", () => {
  it("renders the AI score and reason even when verified page evidence is unavailable", () => {
    const html = renderToStaticMarkup(
      <CriterionEvaluationRow
        item={{
          id: "criterion-1",
          label: "Problem Tanımı",
          score: 18,
          maxScore: 20,
          reason: "Problem açık ve ölçülebilir biçimde tanımlanmış.",
          evidenceIds: [],
        }}
        evidences={[]}
        onEvidence={vi.fn()}
      />
    );

    expect(html).toContain("AI önerisi: 18 / 20");
    expect(html).toContain("Problem açık ve ölçülebilir biçimde tanımlanmış.");
    expect(html).toContain("Sayfa kanıtı doğrulanamadı");
    expect(html).not.toContain("Neden? (Sayfa");
  });
});
