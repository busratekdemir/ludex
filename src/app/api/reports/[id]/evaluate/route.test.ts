import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  findById,
  listAll,
  setAiEvaluation,
  setStatus,
  scoreCriteriaListAll,
  evaluateReport,
  evaluateRelevancePreflight,
  findSimilarReports,
  computeTextSimilarity,
  computeContextHash,
  evaluationPolicyVersion,
  resolveReadiness,
  toPageMarkedContent,
  extractFromStorageObject,
} = vi.hoisted(() => ({
  findById: vi.fn(),
  listAll: vi.fn(),
  setAiEvaluation: vi.fn(),
  setStatus: vi.fn(),
  scoreCriteriaListAll: vi.fn(),
  evaluateReport: vi.fn(),
  evaluateRelevancePreflight: vi.fn(),
  findSimilarReports: vi.fn(),
  computeTextSimilarity: vi.fn(),
  computeContextHash: vi.fn(),
  evaluationPolicyVersion: 2,
  resolveReadiness: vi.fn(),
  toPageMarkedContent: vi.fn(),
  extractFromStorageObject: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({ user: { role: "admin", id: "admin-1" } })),
}));

vi.mock("@/lib/repositories/report-repository", () => ({
  getReportRepository: () => ({ findById, listAll, setAiEvaluation, setStatus }),
}));

vi.mock("@/lib/repositories/score-criteria-repository", () => ({
  getScoreCriteriaRepository: () => ({ listAll: scoreCriteriaListAll }),
}));

vi.mock("@/lib/ai-evaluation/evaluate", () => ({ evaluateReport, evaluateRelevancePreflight }));
vi.mock("@/lib/ai-evaluation/similarity", () => ({ findSimilarReports, computeTextSimilarity }));
vi.mock("@/lib/ai-evaluation/context-hash", () => ({
  computeContextHash,
  EVALUATION_POLICY_VERSION: evaluationPolicyVersion,
}));
vi.mock("@/lib/ai-evaluation/readiness", () => ({ resolveReadiness }));
vi.mock("@/lib/ai-evaluation/report-content", () => ({ toPageMarkedContent }));
vi.mock("@/lib/text-extraction", () => ({
  getTextExtractor: () => ({ extractFromStorageObject }),
}));
// attachVerifiedEvidence (postprocess.ts) kasıtlı olarak mock'lanmadı — gerçek,
// bağımlılıksız bir pure fonksiyon; server-side normalizasyonun ondan ÖNCE
// uygulandığını gerçek davranışıyla doğrulamak için gerçek import kullanılıyor.

import { POST } from "./route";
import { CloudflareAiTimeoutError } from "@/lib/ai-shared/cloudflare-workers-ai";

const REPORT = {
  id: "report-1",
  categoryId: "cat-1",
  assignedJudgeIds: [],
  status: "assigned",
  extractedPages: [{ pageNumber: 1, text: "Rapor içeriği." }],
};

function fakeSpecViolationOutput() {
  return {
    languageAnalysis: { detectedLanguage: "Türkçe", confidence: 0.9, summary: "ok", issues: [] },
    specificationAnalysis: {
      compliant: false,
      findings: [
        {
          ruleText: "Şartname yüklenmelidir.",
          findingText: "Şartname henüz yüklenmemiştir.",
          severity: "high",
        },
      ],
      notes: "Şartname bulunamadı.",
    },
    templateAnalysis: { compliant: true, missingSections: [], notes: "ok" },
    headingContentAnalysis: [
      { sectionId: "sec-1", headingPresent: true, contentMatchesExpectation: true, notes: "ok" },
    ],
    categoryFit: { fit: true, reason: "uygun" },
    criteriaEvaluations: [{ criterionId: "c1", score: 8, reason: "iyi" }],
    strengths: [],
    areasForImprovement: [],
    recommendations: [],
    similarReports: [],
    evidences: [],
  };
}

function makeRequest(options?: { force?: boolean }) {
  const forceQuery = options?.force ? "?force=true" : "";
  return new Request(`http://localhost/api/reports/report-1/evaluate${forceQuery}`, {
    method: "POST",
  });
}

beforeEach(() => {
  findById.mockReset().mockResolvedValue(REPORT);
  listAll.mockReset().mockResolvedValue([REPORT]);
  setAiEvaluation.mockReset().mockResolvedValue(undefined);
  setStatus.mockReset().mockResolvedValue(undefined);
  scoreCriteriaListAll.mockReset().mockResolvedValue([]);
  findSimilarReports.mockReset().mockReturnValue([]);
  computeTextSimilarity.mockReset().mockImplementation((a: string, b: string) => (a === b ? 100 : 0));
  computeContextHash.mockReset().mockReturnValue("hash-1");
  toPageMarkedContent.mockReset().mockReturnValue("[PAGE 1]\nRapor içeriği.");
  extractFromStorageObject.mockReset();
  evaluateReport.mockReset().mockResolvedValue(fakeSpecViolationOutput());
  evaluateRelevancePreflight.mockReset().mockResolvedValue({
    status: "relevant",
    specificationRuleIds: ["spec-rule-1"],
    reportPageNumber: 1,
    reportExcerpt: "Rapor içeriği.",
    explanation: "Kategori problemiyle eşleşiyor.",
    confidence: 0.95,
    mappedConcepts: ["test"],
  });
});

describe("POST /api/reports/[id]/evaluate — deterministik şablon uygunluğu", () => {
  it("AI compliant=true dönse bile coverage eksikse persisted templateAnalysis.compliant false olur", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: {
        id: "cat-1",
        name: "Test Kategorisi",
        specificationText: undefined,
        templateSections: [
          { id: "sec-1", title: "Giriş", expectedContent: "Amaç." },
          { id: "sec-2", title: "Yöntem", expectedContent: "Yöntem." },
        ],
      },
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateReport.mockResolvedValue({
      ...fakeSpecViolationOutput(),
      templateAnalysis: { compliant: true, missingSections: [], notes: "AI şablona uygun dedi." },
      headingContentAnalysis: [
        { sectionId: "sec-1", headingPresent: true, contentMatchesExpectation: true, notes: "ok" },
      ],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();
    const persisted = setAiEvaluation.mock.calls[0][1];

    expect(res.status).toBe(200);
    expect(body.evaluation.templateAnalysis).toEqual({
      compliant: false,
      missingSections: ["sec-2"],
      notes: "AI şablona uygun dedi.",
    });
    expect(persisted.templateAnalysis).toEqual(body.evaluation.templateAnalysis);
  });
});

describe("POST /api/reports/[id]/evaluate — boş şablon kopyası koruması", () => {
  function readyCategory() {
    return {
      id: "cat-1",
      name: "Test Kategorisi",
      specificationText: undefined,
      reportTemplate: { fileUrl: "templates/blank.pdf" },
      templateSections: [{ id: "sec-1", title: "Giriş", expectedContent: "Amaç." }],
    };
  }

  it("fails template content compliance when the report is the exact blank template", async () => {
    const text = "GİRİŞ\nBu bölümde projenizi açıklayınız.\n[Tabloyu doldurunuz]";
    findById.mockResolvedValue({ ...REPORT, extractedText: text });
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: readyCategory(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    extractFromStorageObject.mockResolvedValue({ markdown: text, pages: [] });
    evaluateReport.mockResolvedValue({
      ...fakeSpecViolationOutput(),
      headingContentAnalysis: [{ sectionId: "sec-1", headingPresent: true, contentMatchesExpectation: true, notes: "AI uygun dedi." }],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.evaluation.templateAnalysis.compliant).toBe(false);
    expect(body.evaluation.headingContentAnalysis[0].contentMatchesExpectation).toBe(false);
    expect(body.evaluation.templateAnalysis.notes).toContain("doldurulmamış");
  });

  it("fails a near-identical blank template at the strict threshold", async () => {
    findById.mockResolvedValue({ ...REPORT, extractedText: "blank template with one harmless OCR change" });
    resolveReadiness.mockResolvedValue({ status: "fresh", category: readyCategory(), effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }] });
    extractFromStorageObject.mockResolvedValue({ markdown: "blank template with one harmless OCR change", pages: [] });
    computeTextSimilarity.mockReturnValue(95);

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();
    expect(body.evaluation.templateAnalysis.compliant).toBe(false);
    expect(body.evaluation.headingContentAnalysis[0].contentMatchesExpectation).toBe(false);
  });

  it("does not reject a report with the same headings and substantial unique content", async () => {
    const template = "GİRİŞ\nBu bölümde projenizi açıklayınız.\nYÖNTEM\nBuraya yazınız.";
    const reportText = `${template}\n\nProjemiz, 42 sensörden alınan verileri üç farklı deneyde karşılaştırır. Sonuçlar ve ölçümler aşağıda ayrıntılı olarak sunulmuştur.`;
    findById.mockResolvedValue({ ...REPORT, extractedText: reportText });
    resolveReadiness.mockResolvedValue({ status: "fresh", category: readyCategory(), effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }] });
    extractFromStorageObject.mockResolvedValue({ markdown: template, pages: [] });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();
    expect(body.evaluation.headingContentAnalysis[0].contentMatchesExpectation).toBe(true);
  });

  it("continues evaluation when template extraction fails", async () => {
    findById.mockResolvedValue({ ...REPORT, extractedText: "Gerçek proje içeriği." });
    resolveReadiness.mockResolvedValue({ status: "fresh", category: readyCategory(), effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }] });
    extractFromStorageObject.mockRejectedValue(new Error("storage unavailable"));

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    expect(res.status).toBe(200);
    expect(setAiEvaluation).toHaveBeenCalledTimes(1);
  });

  it("passes legacy local view URLs to extraction as storage keys", async () => {
    findById.mockResolvedValue({ ...REPORT, extractedText: "Gerçek proje içeriği." });
    const category = readyCategory();
    category.reportTemplate.fileUrl = "http://localhost:3000/api/local-storage/pdfs/template.pdf";
    resolveReadiness.mockResolvedValue({ status: "fresh", category, effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }] });
    extractFromStorageObject.mockResolvedValue({ markdown: "blank", pages: [] });

    await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    expect(extractFromStorageObject).toHaveBeenCalledWith("pdfs/template.pdf");
  });
});

describe("POST /api/reports/[id]/evaluate — şartname opsiyonelliği", () => {
  it("kategori şartnamesizken (specificationText undefined) AI'nın uydurduğu ihlali persist etmeden önce normalize eder", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: {
        id: "cat-1",
        name: "Test Kategorisi",
        specificationText: undefined,
        templateSections: [],
      },
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.evaluation.specificationAnalysis).toEqual({
      compliant: true,
      findings: [],
      notes: "Şartname yüklenmediği için şartname uygunluğu değerlendirilmedi.",
    });
    expect(setAiEvaluation).toHaveBeenCalledTimes(1);
    const persisted = setAiEvaluation.mock.calls[0][1];
    expect(persisted.specificationAnalysis.findings).toEqual([]);
    // Diğer alanlar (kriterler, kategori uygunluğu vb.) etkilenmemeli.
    expect(persisted.criteriaEvaluations).toHaveLength(1);
    expect(persisted.categoryFit).toEqual({ fit: true, reason: "uygun" });
  });

  it("kategori şartnamesizken specificationText boş string olsa da aynı şekilde normalize eder", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: {
        id: "cat-1",
        name: "Test Kategorisi",
        specificationText: "   ",
        templateSections: [],
      },
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(body.evaluation.specificationAnalysis.compliant).toBe(true);
    expect(body.evaluation.specificationAnalysis.findings).toEqual([]);
  });

  it("persists a valid mandatory rule with server-authoritative text", async () => {
    findById.mockResolvedValue({
      ...REPORT,
      extractedText: "Rapor tek sensör kullanıyor.",
      extractedPages: [{ pageNumber: 1, text: "Rapor tek sensör kullanıyor." }],
    });
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: {
        id: "cat-1",
        name: "Test Kategorisi",
        specificationText: "Rapor en az iki bağımsız sensör içermelidir.",
        templateSections: [],
      },
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateReport.mockResolvedValue({
      ...fakeSpecViolationOutput(),
      specificationAnalysis: {
        compliant: false,
        findings: [
          {
            ruleId: "spec-rule-1",
            ruleText: "AI tarafından yazılmış kural özeti.",
            findingText: "Rapor tek sensör kullanıyor.",
            severity: "high",
            classification: "requirement",
            pageNumber: 1,
            exactExcerpt: "tek sensör kullanıyor",
          },
        ],
        notes: "Şartnameye aykırı bir durum tespit edildi.",
      },
    });
    evaluateRelevancePreflight.mockResolvedValue({
      status: "relevant",
      specificationRuleIds: ["spec-rule-1"],
      reportPageNumber: 1,
      reportExcerpt: "Rapor tek sensör kullanıyor.",
      explanation: "Rapor yarışma problemiyle eşleşiyor.",
      confidence: 0.95,
      mappedConcepts: ["sensör"],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(body.evaluation.specificationAnalysis.compliant).toBe(false);
    expect(body.evaluation.specificationAnalysis.findings).toHaveLength(1);
    expect(body.evaluation.specificationAnalysis.findings[0].ruleText).toBe(
      "Rapor en az iki bağımsız sensör içermelidir."
    );
  });
});

describe("POST /api/reports/[id]/evaluate — relevance preflight", () => {
  function categoryWithSpecification() {
    return {
      id: "cat-1",
      name: "İHA Yarışması",
      specificationText: "İHA, otonom uçuş görevi için tasarlanmalıdır.",
      templateSections: [{ id: "sec-1", title: "Amaç", expectedContent: "Proje amacı." }],
    };
  }

  it("uncertain preflight runs full evaluation and does not manufacture compliance failures", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: categoryWithSpecification(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateRelevancePreflight.mockResolvedValue({
      status: "uncertain",
      specificationRuleIds: [],
      explanation: "Kategori/problem eşleşmesi için yeterli kanıt yok.",
      confidence: 0.4,
      mappedConcepts: [],
    });
    evaluateReport.mockResolvedValue({
      ...fakeSpecViolationOutput(),
      specificationAnalysis: {
        compliant: false,
        findings: [],
        notes: "Doğrulanmış bir şartname ihlali bulunamadı.",
      },
      criteriaEvaluations: [
        {
          criterionId: "c1",
          score: 8,
          reason: "Kriter değerlendirildi.",
          pageNumber: 1,
          exactExcerpt: "Rapor içeriği.",
        },
      ],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(evaluateReport).toHaveBeenCalledTimes(1);
    expect(body.evaluation.relevanceAnalysis.status).toBe("uncertain");
    expect(body.evaluation.specificationAnalysis.compliant).toBe(true);
    expect(body.evaluation.templateAnalysis.compliant).toBe(true);
    expect(body.evaluation.criteriaEvaluations[0]).toMatchObject({ score: 8 });
  });

  it("verified high-confidence unrelated preflight blocks scoring without creating spec/template violations", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: categoryWithSpecification(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateRelevancePreflight.mockResolvedValue({
      status: "unrelated",
      specificationRuleIds: ["spec-rule-1"],
      reportPageNumber: 1,
      reportExcerpt: "Rapor içeriği.",
      explanation: "Rapor farklı bir problemi çözüyor.",
      confidence: 0.95,
      mappedConcepts: [],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(evaluateReport).not.toHaveBeenCalled();
    expect(body.evaluation.relevanceAnalysis.status).toBe("unrelated");
    expect(body.evaluation.specificationAnalysis).toMatchObject({ compliant: true, findings: [] });
    expect(body.evaluation.templateAnalysis).toMatchObject({ compliant: true, missingSections: [] });
    expect(body.evaluation.criteriaEvaluations[0]).toMatchObject({
      score: null,
      scoreUnavailableReason: "relevance_blocked",
    });
  });

  it("unverifiable preflight excerpt becomes uncertain but full evaluation remains specification-compliant", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: categoryWithSpecification(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateRelevancePreflight.mockResolvedValue({
      status: "unrelated",
      specificationRuleIds: ["spec-rule-1"],
      reportPageNumber: 1,
      reportExcerpt: "Raporda bulunmayan uydurma alıntı.",
      explanation: "Rapor farklı bir problemi çözüyor.",
      confidence: 0.99,
      mappedConcepts: [],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(evaluateReport).toHaveBeenCalledTimes(1);
    expect(body.evaluation.relevanceAnalysis.status).toBe("uncertain");
    expect(body.evaluation.relevanceAnalysis).not.toHaveProperty("reportPageNumber");
    expect(body.evaluation.relevanceAnalysis).not.toHaveProperty("reportExcerpt");
    expect(body.evaluation.specificationAnalysis).toMatchObject({ compliant: true, findings: [] });
  });

  it("validated relevant preflight continues to the detailed scoring AI call", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: categoryWithSpecification(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });

    expect(res.status).toBe(200);
    expect(evaluateRelevancePreflight).toHaveBeenCalledTimes(1);
    expect(evaluateReport).toHaveBeenCalledTimes(1);
  });

  it("removes a fake specification finding and derives compliant=true", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: categoryWithSpecification(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateReport.mockResolvedValue({
      ...fakeSpecViolationOutput(),
      specificationAnalysis: {
        compliant: false,
        findings: [
          {
            ruleId: "invented-rule-id",
            ruleText: "Uydurma kural.",
            findingText: "Rapor içeriği ihlal sayıldı.",
            severity: "high",
            pageNumber: 1,
            exactExcerpt: "Rapor içeriği.",
          },
        ],
        notes: "AI ihlal bildirdi.",
      },
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(body.evaluation.specificationAnalysis).toMatchObject({ compliant: true, findings: [] });
  });
});

describe("POST /api/reports/[id]/evaluate — effective criteria pipeline", () => {
  it("sends category-specific judge criteria to AI and preserves their ids/max scores", async () => {
    const effectiveCriteria = [
      { id: "category-innovation", label: "Kategori Yenilik", description: "Özgünlük", maxScore: 12 },
      { id: "category-impact", label: "Kategori Etki", description: "Etki", maxScore: 8 },
    ];
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: {
        id: "cat-1",
        name: "Test Kategorisi",
        criteria: effectiveCriteria,
        specificationText: undefined,
        templateSections: [{ id: "sec-1", title: "Giriş", expectedContent: "Amaç." }],
      },
      effectiveCriteria,
    });
    evaluateReport.mockResolvedValue({
      ...fakeSpecViolationOutput(),
      criteriaEvaluations: [
        {
          criterionId: "category-innovation",
          score: 12,
          reason: "Tam.",
          pageNumber: 1,
          exactExcerpt: "Rapor içeriği.",
        },
        {
          criterionId: "category-impact",
          score: 8,
          reason: "Tam.",
          pageNumber: 1,
          exactExcerpt: "Rapor içeriği.",
        },
      ],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(evaluateReport.mock.calls[0][0].evaluationCriteria).toEqual([
      { id: "category-innovation", name: "Kategori Yenilik", description: "Özgünlük", maxScore: 12 },
      { id: "category-impact", name: "Kategori Etki", description: "Etki", maxScore: 8 },
    ]);
    expect(body.evaluation.criteriaEvaluations).toEqual([
      expect.objectContaining({ criterionId: "category-innovation", score: 12, criterionLabel: "Kategori Yenilik", criterionMaxScore: 12 }),
      expect.objectContaining({ criterionId: "category-impact", score: 8, criterionLabel: "Kategori Etki", criterionMaxScore: 8 }),
    ]);
  });

  it("sends global fallback criteria to AI when readiness resolves no category-specific criteria", async () => {
    const globalCriteria = [
      { id: "global-method", label: "Global Yöntem", description: "Yöntem", maxScore: 20 },
    ];
    scoreCriteriaListAll.mockResolvedValue(globalCriteria);
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: {
        id: "cat-1",
        name: "Test Kategorisi",
        criteria: [],
        specificationText: undefined,
        templateSections: [{ id: "sec-1", title: "Giriş", expectedContent: "Amaç." }],
      },
      effectiveCriteria: globalCriteria,
    });
    evaluateReport.mockResolvedValue({
      ...fakeSpecViolationOutput(),
      criteriaEvaluations: [
        {
          criterionId: "global-method",
          score: 20,
          reason: "Tam.",
          pageNumber: 1,
          exactExcerpt: "Rapor içeriği.",
        },
      ],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(evaluateReport.mock.calls[0][0].evaluationCriteria).toEqual([
      { id: "global-method", name: "Global Yöntem", description: "Yöntem", maxScore: 20 },
    ]);
    expect(body.evaluation.criteriaEvaluations[0]).toMatchObject({
      criterionId: "global-method",
      score: 20,
      criterionLabel: "Global Yöntem",
      criterionMaxScore: 20,
    });
  });
});

describe("POST /api/reports/[id]/evaluate — kriter semantic validation", () => {
  it("rejects invalid criteria output without persisting it", async () => {
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: {
        id: "cat-1",
        name: "Test Kategorisi",
        specificationText: undefined,
        templateSections: [],
      },
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateReport.mockResolvedValue({
      ...fakeSpecViolationOutput(),
      criteriaEvaluations: [{ criterionId: "unknown", score: 8, reason: "iyi" }],
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });

    expect(res.status).toBe(400);
    expect(setAiEvaluation).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports/[id]/evaluate — cache ve timeout", () => {
  function readyCategory() {
    return {
      id: "cat-1",
      name: "Test Kategorisi",
      specificationText: undefined,
      templateSections: [{ id: "sec-1", title: "Giriş", expectedContent: "Amaç." }],
    };
  }

  it("returns a fresh cached AIAnalysis without calling Cloudflare or persistence", async () => {
    const cachedEvaluation = fakeSpecViolationOutput();
    findById.mockResolvedValue({ ...REPORT, aiEvaluation: cachedEvaluation });
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: readyCategory(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, cached: true, evaluation: cachedEvaluation });
    expect(evaluateRelevancePreflight).not.toHaveBeenCalled();
    expect(evaluateReport).not.toHaveBeenCalled();
    expect(setAiEvaluation).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[AI PERF\] report=report-1 readiness=\d+ms preflight=0ms evaluation=0ms postprocess=0ms persistence=0ms total=\d+ms outcome=cache_hit$/
      )
    );
    info.mockRestore();
  });

  it("reruns and persists a fresh analysis when force=true", async () => {
    const cachedEvaluation = { ...fakeSpecViolationOutput(), strengths: ["Eski sonuç."] };
    const newEvaluation = { ...fakeSpecViolationOutput(), strengths: ["Yeni sonuç."] };
    findById.mockResolvedValue({ ...REPORT, aiEvaluation: cachedEvaluation });
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: readyCategory(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateReport.mockResolvedValue(newEvaluation);

    const res = await POST(makeRequest({ force: true }), {
      params: Promise.resolve({ id: "report-1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cached).toBeUndefined();
    expect(body.evaluation.strengths).toEqual(["Yeni sonuç."]);
    expect(evaluateReport).toHaveBeenCalledTimes(1);
    expect(setAiEvaluation).toHaveBeenCalledTimes(1);
    expect(setAiEvaluation.mock.calls[0][1].strengths).toEqual(["Yeni sonuç."]);
  });

  it("reruns a stale analysis without requiring force", async () => {
    const cachedEvaluation = { ...fakeSpecViolationOutput(), strengths: ["Eski sonuç."] };
    findById.mockResolvedValue({ ...REPORT, aiEvaluation: cachedEvaluation });
    resolveReadiness.mockResolvedValue({
      status: "stale",
      message: "Yönergeler değişti.",
      category: readyCategory(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateReport.mockResolvedValue({ ...fakeSpecViolationOutput(), strengths: ["Yeni sonuç."] });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "report-1" }) });

    expect(res.status).toBe(200);
    expect(evaluateReport).toHaveBeenCalledTimes(1);
    expect(setAiEvaluation).toHaveBeenCalledTimes(1);
    expect(setAiEvaluation.mock.calls[0][1].strengths).toEqual(["Yeni sonuç."]);
  });

  it("preserves the previous successful cache when a forced fresh rerun times out", async () => {
    const cachedEvaluation = fakeSpecViolationOutput();
    findById.mockResolvedValue({ ...REPORT, aiEvaluation: cachedEvaluation });
    resolveReadiness.mockResolvedValue({
      status: "fresh",
      category: readyCategory(),
      effectiveCriteria: [{ id: "c1", label: "Kriter 1", maxScore: 10 }],
    });
    evaluateReport.mockRejectedValue(new CloudflareAiTimeoutError());

    const res = await POST(makeRequest({ force: true }), {
      params: Promise.resolve({ id: "report-1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(504);
    expect(body.error).toContain("90 saniye içinde yanıt veremedi");
    expect(body.error).toContain("Mevcut başarılı analiz korundu");
    expect(evaluateReport).toHaveBeenCalledTimes(1);
    expect(setAiEvaluation).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
