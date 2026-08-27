import { normalizeSpecificationAnalysis } from "@/lib/specification-compliance";
import type {
  AIAnalysisResult,
  AIEvaluationOutput,
  ComplianceCheckItem,
  CriterionAiEvaluation,
  CriticalSpecFinding,
} from "@/types";

/**
 * Gerçek AI çıktısını AIAnalysisResult şekline dönüştürür. Gerçek pipeline
 * kırmızı bayrak / AI yazım riski / genel puan ÜRETMEZ (bkz.
 * ai-evaluation/prompts.ts — bilerek böyle tasarlanmış, hakemin nihai
 * kararını AI'nın gölgelememesi için). Bu alanlar burada UYDURULMAZ; boş/
 * tanımsız bırakılır. Şartname uygunluğu, şablon uygunluğu, kriter
 * değerlendirmesi ve benzerlik ise artık gerçek pipeline'ın ürettiği somut
 * verilerle doldurulur; sunucu tarafında doğrulanmamış hiçbir
 * pageNumber/exactExcerpt buraya kadar gelmez (bkz. postprocess.ts).
 *
 * Report.aiEvaluation üzerinden gelen, zaten sunucuda üretilmiş güncel bir
 * sonucu göstermek için de kullanılır (bkz. evaluation-workspace.tsx) —
 * böylece aynı dönüşüm mantığı iki yerde kopyalanmaz.
 *
 * hasSpecification: kategori şu an gerçekten bir şartname metni içeriyor mu.
 * false ise specificationAnalysis, çağıranın (fresh POST yanıtı ya da DB'de
 * önceden kaydedilmiş eski bir cache satırı) ne getirdiğinden bağımsız
 * olarak normalizeSpecificationAnalysis ile güvenli/nötr bir sonuca
 * sabitlenir — böylece admin şartname yüklememişken AI'nın (ya da bu
 * düzeltmeden önce üretilmiş eski bir kayıtta donmuş) uydurma bir ihlal
 * bulgusu asla hakeme gösterilmez.
 */
export function toAIAnalysisResult(
  reportId: string,
  output: AIEvaluationOutput,
  hasSpecification: boolean
): AIAnalysisResult {
  // Old cached analyses may predate server-side normalization. Keep the UI
  // safe and conservative even when such a record is opened directly.
  const headingItemsById = new Map<string, (typeof output.headingContentAnalysis)[number]>();
  const duplicateHeadingIds = new Set<string>();
  for (const item of output.headingContentAnalysis) {
    if (headingItemsById.has(item.sectionId)) duplicateHeadingIds.add(item.sectionId);
    else headingItemsById.set(item.sectionId, item);
  }
  const headingContentAnalysis = [...headingItemsById.values()].map((item) =>
    duplicateHeadingIds.has(item.sectionId)
      ? {
          ...item,
          headingPresent: false,
          contentMatchesExpectation: false,
          notes: `${item.notes} Birden fazla kayıt bulundu; uygunluk doğrulanamadı.`,
        }
      : item
  );

  const specificationAnalysis = normalizeSpecificationAnalysis(
    output.specificationAnalysis,
    hasSpecification,
    output.languageAnalysis
  );

  const specCompliance: ComplianceCheckItem[] =
    specificationAnalysis.findings.length === 0
      ? [
          {
            id: "specification",
            label: "Şartname Uygunluğu",
            passed: specificationAnalysis.compliant,
            detail: specificationAnalysis.notes,
            evidenceIds: [],
          },
        ]
      : specificationAnalysis.findings.map((finding, index) => {
          const id = `spec-${index}`;
          const hasEvidence = Boolean(finding.pageNumber && finding.exactExcerpt);
          return {
            id,
            label: finding.ruleText,
            passed: false,
          detail: finding.findingText,
            evidenceIds: hasEvidence ? [id] : [],
            unverifiable: !hasEvidence,
          severity: finding.severity,
          decisionSupport: finding.classification,
          sourceLabel: finding.ruleSourceLabel,
          };
        });

  const criticalFindings: CriticalSpecFinding[] = specificationAnalysis.findings
    .map((finding, index) => ({ finding, index }))
    .filter(
      ({ finding }) =>
        finding.classification === "disqualification" &&
        Boolean(finding.pageNumber && finding.exactExcerpt)
    )
    .map(({ finding, index }) => {
      const id = `spec-${index}`;
      const hasEvidence = Boolean(finding.pageNumber && finding.exactExcerpt);
      return {
        id,
        ruleText: finding.ruleText,
        findingText: finding.findingText,
        probability: finding.severity,
        evidenceId: hasEvidence ? id : null,
        classification: finding.classification,
        sourceLabel: finding.ruleSourceLabel,
      };
    });

  const templateWasEvaluated = output.relevanceAnalysis?.status !== "unrelated";
  const templateCompliance: ComplianceCheckItem[] = templateWasEvaluated
    ? headingContentAnalysis.map((h) => {
        const id = `heading-${h.sectionId}`;
        const hasEvidence = Boolean(h.pageNumber && h.exactExcerpt);
        const missing = output.templateAnalysis.missingSections.includes(h.sectionId);
        return {
          id,
          label: h.sectionId,
          passed: h.headingPresent && h.contentMatchesExpectation,
          detail: h.notes,
          evidenceIds: hasEvidence ? [id] : [],
          // Bölüm tamamen eksikse (missingSections) işaretlenecek bir konum
          // yoktur — sahte bir highlight üretmek yerine bunu açıkça belirtiriz.
          unverifiable: !hasEvidence && (missing || !h.headingPresent),
        };
      })
    : [];
  const existingTemplateSectionIds = new Set(
    headingContentAnalysis.map((section) => section.sectionId)
  );
  for (const sectionId of templateWasEvaluated ? output.templateAnalysis.missingSections : []) {
    if (existingTemplateSectionIds.has(sectionId)) continue;
    templateCompliance.push({
      id: `heading-${sectionId}`,
      label: sectionId,
      passed: false,
      detail: "Bölüm raporda bulunamadı.",
      evidenceIds: [],
      unverifiable: true,
    });
  }

  const criteriaEvaluations: CriterionAiEvaluation[] = output.criteriaEvaluations.map((c) => {
    const id = `criterion-${c.criterionId}`;
    const hasEvidence = Boolean(c.pageNumber && c.exactExcerpt);
    return {
      id: c.criterionId,
      label: c.criterionLabel ?? c.criterionId,
      score: c.score,
      scoreUnavailableReason:
        c.score != null ? undefined : c.scoreUnavailableReason ?? (c.criterionMaxScore ? "evidence_unverified" : "scale_missing"),
      maxScore: c.criterionMaxScore,
      reason: c.reason,
      evidenceIds: hasEvidence ? [id] : [],
    };
  });

  return {
    reportId,
    generatedAt: new Date().toISOString(),

    languageCheck: {
      detectedLanguage: output.languageAnalysis.detectedLanguage,
      // Gerçek pipeline'a ayrı bir "beklenen dil" parametresi verilmiyor —
      // tespit edileni tekrar etmek, var olmayan bir beklentiyi uydurmaktan iyidir.
      expectedLanguage: output.languageAnalysis.detectedLanguage,
      passed: output.languageAnalysis.issues.length === 0,
      confidence: Math.round(output.languageAnalysis.confidence * 100),
    },

    categoryFitCheck: {
      matchedCategoryId: "",
      passed: output.categoryFit.fit,
      explanation: output.categoryFit.reason,
    },
    relevanceAnalysis: output.relevanceAnalysis,
    overallComplianceStatus: output.overallComplianceStatus,

    ruleProfile: { prohibitions: [], requirements: [], technicalRules: [] },
    criticalFindings,
    redFlags: [],
    specCompliance,
    templateCompliance,
    criteriaEvaluations,

    contentAnalysis: {
      summary: output.templateAnalysis.notes,
      strengths: output.strengths,
      weaknesses: output.areasForImprovement,
      improvementSuggestions: output.recommendations,
    },

    similarReports: output.similarReports,
    similarityScore: output.similarityScore,
    evidences: output.evidences.filter(
      (evidence, index, all) => all.findIndex((candidate) => candidate.id === evidence.id) === index
    ),
  };
}

export async function getAIAnalysis(
  reportId: string,
  hasSpecification: boolean,
  /** Yalnızca kullanıcı açıkça yeniden çalıştırmayı seçtiğinde true olmalı. */
  options?: { force?: boolean }
): Promise<AIAnalysisResult> {
  const forceQuery = options?.force ? "?force=true" : "";
  const res = await fetch(`/api/reports/${reportId}/evaluate${forceQuery}`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? "AI analizi alınamadı.");
  }

  return toAIAnalysisResult(reportId, data.evaluation, hasSpecification);
}
