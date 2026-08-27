import { describe, expect, it } from "vitest";
import {
  computeAiPreliminaryScore,
  computeOverallScoreDiff,
  hasCompleteJudgeScore,
} from "./ai-preliminary-score";
import { toAIAnalysisResult } from "@/services/ai-analysis.service";
import type { AIEvaluationOutput } from "@/types";

/**
 * Adminin AIAnalysis DB satırından okuduğu ham şekil (criterionMaxScore) ile
 * hakem ekranının toAIAnalysisResult() ile map'lediği önbelleklenmiş şekli
 * (maxScore) — item 7: "cache reuse" senaryosunda ikisinin de AYNI
 * AI Ön Puanı'nı üretmesi gerekir.
 */
const CACHED_EVALUATION: AIEvaluationOutput = {
  languageAnalysis: {
    detectedLanguage: "Türkçe",
    confidence: 0.95,
    summary: "Rapor Türkçe yazılmış.",
    issues: [],
  },
  specificationAnalysis: { compliant: true, findings: [], notes: "Şartname yüklenmemiş." },
  templateAnalysis: { compliant: true, missingSections: [], notes: "Şablona uygun." },
  headingContentAnalysis: [],
  categoryFit: { fit: true, reason: "Kategoriyle uyumlu." },
  criteriaEvaluations: [
    { criterionId: "c1", score: 17, reason: "Problem net tanımlanmış.", criterionMaxScore: 20 },
    { criterionId: "c2", score: 25, reason: "Teknik çözüm yeterli.", criterionMaxScore: 30 },
    { criterionId: "c3", score: 23, reason: "AI yöntemi açıklanmış.", criterionMaxScore: 30 },
    { criterionId: "c4", score: 16, reason: "Etki değerlendirilmiş.", criterionMaxScore: 20 },
  ],
  strengths: [],
  areasForImprovement: [],
  recommendations: [],
  similarReports: [],
  evidences: [],
};

describe("computeAiPreliminaryScore", () => {
  it("sums criterion scores and max scores deterministically (17/20 + 25/30 + 23/30 + 16/20 = 81/100)", () => {
    const result = computeAiPreliminaryScore([
      { score: 17, maxScore: 20 },
      { score: 25, maxScore: 30 },
      { score: 23, maxScore: 30 },
      { score: 16, maxScore: 20 },
    ]);

    expect(result).toEqual({ score: 81, maxScore: 100, incomplete: false, missingCount: 0 });
  });

  it("includes preserved scores whose optional page evidence is unavailable (12/15 + 21/25 + 18/25 + 16/20 + 13/15 = 80/100)", () => {
    const criteriaWithoutPageEvidence = [
      { score: 12, criterionMaxScore: 15 },
      { score: 21, criterionMaxScore: 25 },
      { score: 18, criterionMaxScore: 25 },
      { score: 16, criterionMaxScore: 20 },
      { score: 13, criterionMaxScore: 15 },
    ];

    const result = computeAiPreliminaryScore(
      criteriaWithoutPageEvidence.map((criterion) => ({
        score: criterion.score,
        maxScore: criterion.criterionMaxScore,
      }))
    );

    expect(result).toEqual({ score: 80, maxScore: 100, incomplete: false, missingCount: 0 });
  });

  it("marks the total as incomplete instead of silently treating a null score as 0", () => {
    const result = computeAiPreliminaryScore([
      { score: 17, maxScore: 20 },
      { score: null, maxScore: 30 },
      { score: 23, maxScore: 30 },
    ]);

    expect(result?.incomplete).toBe(true);
    expect(result?.missingCount).toBe(1);
    // The null-score criterion must not contribute a fake 0/30 to the total.
    expect(result?.score).toBe(40);
    expect(result?.maxScore).toBe(50);
  });

  it("marks the total as incomplete when a criterion has no maxScore defined", () => {
    const result = computeAiPreliminaryScore([
      { score: 17, maxScore: 20 },
      { score: 10, maxScore: undefined },
    ]);

    expect(result?.incomplete).toBe(true);
    expect(result?.missingCount).toBe(1);
    expect(result?.score).toBe(17);
    expect(result?.maxScore).toBe(20);
  });

  it("returns null when there are no criteria at all", () => {
    expect(computeAiPreliminaryScore([])).toBeNull();
  });

  it("computes the same AI Ön Puanı from the raw cached AIAnalysis row (admin) and from toAIAnalysisResult (judge)", () => {
    // Admin okur: doğrudan report.aiEvaluation.criteriaEvaluations (criterionMaxScore).
    const fromRawCache = computeAiPreliminaryScore(
      CACHED_EVALUATION.criteriaEvaluations.map((c) => ({
        score: c.score,
        maxScore: c.criterionMaxScore,
      })),
    );

    // Hakem okur: aynı report.aiEvaluation, toAIAnalysisResult() ile map'lenmiş (maxScore).
    const mapped = toAIAnalysisResult("report-1", CACHED_EVALUATION, false);
    const fromMappedCache = computeAiPreliminaryScore(
      mapped.criteriaEvaluations.map((c) => ({ score: c.score, maxScore: c.maxScore })),
    );

    expect(fromRawCache).toEqual({ score: 81, maxScore: 100, incomplete: false, missingCount: 0 });
    expect(fromMappedCache).toEqual(fromRawCache);
  });
});

describe("hasCompleteJudgeScore / computeOverallScoreDiff", () => {
  const SCORE_CRITERIA = [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }];
  const AI_SCORE = { score: 81, maxScore: 100, incomplete: false, missingCount: 0 };

  it("has no overall diff when the judge has not entered any score yet", () => {
    const scores = {};

    expect(hasCompleteJudgeScore(SCORE_CRITERIA, scores)).toBe(false);
    // Regression: totalScore would be 0 here, which must NOT be compared
    // against the AI score (that would show a fake "-81 fark").
    expect(computeOverallScoreDiff(AI_SCORE, hasCompleteJudgeScore(SCORE_CRITERIA, scores), 0)).toBeNull();
  });

  it("has no overall diff when the judge has only scored some of the criteria", () => {
    const scores = { c1: 18, c2: 26 };

    expect(hasCompleteJudgeScore(SCORE_CRITERIA, scores)).toBe(false);
    expect(
      computeOverallScoreDiff(AI_SCORE, hasCompleteJudgeScore(SCORE_CRITERIA, scores), 44),
    ).toBeNull();
  });

  it("computes the correct overall diff once the judge has scored every criterion", () => {
    const scores = { c1: 18, c2: 26, c3: 24, c4: 15 };
    const judgeTotal = 18 + 26 + 24 + 15; // 83

    expect(hasCompleteJudgeScore(SCORE_CRITERIA, scores)).toBe(true);
    expect(
      computeOverallScoreDiff(AI_SCORE, hasCompleteJudgeScore(SCORE_CRITERIA, scores), judgeTotal),
    ).toBe(2);
  });

  it("has no overall diff when the AI preliminary score itself is incomplete, even if the judge scored everything", () => {
    const scores = { c1: 18, c2: 26, c3: 24, c4: 15 };
    const incompleteAiScore = { score: 40, maxScore: 50, incomplete: true, missingCount: 1 };

    expect(
      computeOverallScoreDiff(incompleteAiScore, hasCompleteJudgeScore(SCORE_CRITERIA, scores), 83),
    ).toBeNull();
  });
});
