import { describe, expect, it } from "vitest";
import { attachVerifiedEvidence } from "./postprocess";
import type { EvaluationOutput } from "./schema";

const PAGES = [
  { pageNumber: 1, text: "Giriş bölümü burada başlar." },
  { pageNumber: 2, text: "Sistem en az iki bağımsız sensör kullanır." },
];

function baseEvaluation(): EvaluationOutput {
  return {
    languageAnalysis: { detectedLanguage: "Türkçe", confidence: 0.95, summary: "Ok", issues: [] },
    specificationAnalysis: {
      compliant: false,
      findings: [
        {
          ruleText: "En az iki sensör zorunludur.",
          findingText: "Rapor bunu doğruluyor.",
          severity: "high",
          pageNumber: 2,
          exactExcerpt: "en az iki bağımsız sensör",
        },
        {
          ruleText: "Uydurulmuş bir kural.",
          findingText: "Raporda gerçekte olmayan bir alıntı.",
          severity: "high",
          pageNumber: 2,
          exactExcerpt: "bu cümle raporda yok",
        },
      ],
      notes: "notlar",
    },
    templateAnalysis: { compliant: true, missingSections: [], notes: "notlar" },
    headingContentAnalysis: [
      { sectionId: "sec-1", headingPresent: true, contentMatchesExpectation: true, notes: "ok" },
    ],
    categoryFit: { fit: true, reason: "uygun" },
    relevanceAnalysis: {
      status: "relevant",
      specificationRuleIds: ["spec-rule-1"],
      reportPageNumber: 1,
      reportExcerpt: "Giriş bölümü burada başlar.",
      explanation: "uygun",
      confidence: 0.9,
      mappedConcepts: ["konu"],
    },
    overallComplianceStatus: "compliant",
    criteriaEvaluations: [{ criterionId: "crit-1", score: 8, reason: "iyi" }],
    strengths: [],
    areasForImprovement: [],
    recommendations: [],
    similarReports: [],
    evidences: [],
  };
}

describe("attachVerifiedEvidence", () => {
  it("preserves a positive criterion score and reason when no page evidence was supplied", () => {
    const result = attachVerifiedEvidence(baseEvaluation(), PAGES);

    expect(result.criteriaEvaluations[0]).toEqual({
      criterionId: "crit-1",
      score: 8,
      reason: "iyi",
      pageNumber: undefined,
      exactExcerpt: undefined,
    });
  });

  it("removes an invalid criterion excerpt without discarding its score", () => {
    const evaluation = baseEvaluation();
    evaluation.criteriaEvaluations[0] = {
      criterionId: "crit-1",
      score: 8,
      reason: "Somut gerekçe korundu.",
      pageNumber: 2,
      exactExcerpt: "raporda bulunmayan kriter alıntısı",
    };

    const result = attachVerifiedEvidence(evaluation, PAGES);

    expect(result.criteriaEvaluations[0]).toEqual({
      criterionId: "crit-1",
      score: 8,
      reason: "Somut gerekçe korundu.",
      pageNumber: undefined,
      exactExcerpt: undefined,
    });
    expect(result.evidences.find((e) => e.id === "criterion-crit-1")).toBeUndefined();
  });

  it("preserves both a criterion score and its verified evidence", () => {
    const evaluation = baseEvaluation();
    evaluation.criteriaEvaluations[0] = {
      criterionId: "crit-1",
      score: 8,
      reason: "Somut gerekçe korundu.",
      pageNumber: 2,
      exactExcerpt: "en az iki bağımsız sensör",
    };

    const result = attachVerifiedEvidence(evaluation, PAGES);

    expect(result.criteriaEvaluations[0]).toMatchObject({
      score: 8,
      pageNumber: 2,
      exactExcerpt: "en az iki bağımsız sensör",
    });
    expect(result.evidences).toContainEqual(
      expect.objectContaining({
        id: "criterion-crit-1",
        page: 2,
        excerpt: "en az iki bağımsız sensör",
      })
    );
  });

  it("keeps a verified finding's pageNumber/exactExcerpt and adds it to evidences", () => {
    const result = attachVerifiedEvidence(baseEvaluation(), PAGES);
    const verifiedFinding = result.specificationAnalysis.findings[0];
    expect(verifiedFinding.pageNumber).toBe(2);
    expect(verifiedFinding.exactExcerpt).toBe("en az iki bağımsız sensör");
    expect(result.evidences).toContainEqual(
      expect.objectContaining({ id: "spec-0", page: 2, excerpt: "en az iki bağımsız sensör" })
    );
  });

  it("strips a fabricated excerpt and does not add fake evidence for it", () => {
    const result = attachVerifiedEvidence(baseEvaluation(), PAGES);
    const fabricatedFinding = result.specificationAnalysis.findings[1];
    expect(fabricatedFinding.pageNumber).toBeUndefined();
    expect(fabricatedFinding.exactExcerpt).toBeUndefined();
    expect(result.evidences.find((e) => e.id === "spec-1")).toBeUndefined();
  });

  it("produces no evidences when the report has no page data", () => {
    const result = attachVerifiedEvidence(baseEvaluation(), null);
    expect(result.evidences).toEqual([]);
    expect(result.specificationAnalysis.findings.every((f) => f.pageNumber === undefined)).toBe(true);
  });

  it("drops any strengths/areasForImprovement/recommendations mentioning HTML or Markdown by name", () => {
    const evaluation = baseEvaluation();
    evaluation.strengths = ["İçerik güçlü.", "HTML kullanımı temiz."];
    evaluation.areasForImprovement = [
      "Markdown/HTML formatlama hataları",
      "Başlık seviyelerinde tutarsızlık",
    ];
    evaluation.recommendations = ["Markdown formatını standartlaştırın.", "Özet bölümü ekleyin."];

    const result = attachVerifiedEvidence(evaluation, PAGES);

    expect(result.strengths).toEqual(["İçerik güçlü."]);
    expect(result.areasForImprovement).toEqual(["Başlık seviyelerinde tutarsızlık"]);
    expect(result.recommendations).toEqual(["Özet bölümü ekleyin."]);
  });

  it("keeps persisted evidence IDs unique even when raw heading IDs repeat", () => {
    const evaluation = baseEvaluation();
    evaluation.headingContentAnalysis = [
      { sectionId: "sec-1", headingPresent: true, contentMatchesExpectation: true, notes: "one", pageNumber: 1, exactExcerpt: "Giriş bölümü burada başlar." },
      { sectionId: "sec-1", headingPresent: true, contentMatchesExpectation: true, notes: "two", pageNumber: 1, exactExcerpt: "Giriş bölümü burada başlar." },
    ];

    const result = attachVerifiedEvidence(evaluation, PAGES);
    expect(new Set(result.evidences.map((evidence) => evidence.id)).size).toBe(
      result.evidences.length
    );
  });
});
