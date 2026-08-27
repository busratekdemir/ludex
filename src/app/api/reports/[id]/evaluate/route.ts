import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { getReportRepository } from "@/lib/repositories/report-repository";
import { getScoreCriteriaRepository } from "@/lib/repositories/score-criteria-repository";
import type { CategoryEvaluationCriterion } from "@/lib/repositories/category-repository";
import { evaluateRelevancePreflight, evaluateReport } from "@/lib/ai-evaluation/evaluate";
import { computeTextSimilarity, findSimilarReports } from "@/lib/ai-evaluation/similarity";
import { attachVerifiedEvidence } from "@/lib/ai-evaluation/postprocess";
import {
  deriveTemplateCompliance,
  normalizeHeadingContentAnalysis,
} from "@/lib/ai-evaluation/template-compliance";
import { computeContextHash, EVALUATION_POLICY_VERSION } from "@/lib/ai-evaluation/context-hash";
import { resolveReadiness } from "@/lib/ai-evaluation/readiness";
import { toPageMarkedContent } from "@/lib/ai-evaluation/report-content";
import {
  buildAuthoritativeSpecificationRules,
  normalizeSpecificationAnalysis,
  reconcileLanguageCompliance,
  validateRelevanceAnalysis,
  validateSpecificationFindings,
} from "@/lib/specification-compliance";
import { getTextExtractor } from "@/lib/text-extraction";
import {
  InvalidCriteriaEvaluationsError,
  validateCriteriaEvaluations,
} from "@/lib/ai-evaluation/criteria-validation";
import { CloudflareAiTimeoutError } from "@/lib/ai-shared/cloudflare-workers-ai";
import type { ScoreCriterion } from "@/types";
import type { EvaluationInput, EvaluationOutput, RelevanceAnalysis } from "@/lib/ai-evaluation/schema";

/** Hakemin puanladığı efektif kriterleri (kategoriye özel ya da global), AI'nın beklediği şekle çevirir. */
function toAiCriteria(criteria: ScoreCriterion[]): CategoryEvaluationCriterion[] {
  return criteria.map((c) => ({
    id: c.id,
    name: c.label,
    description: c.description?.trim() || c.label,
    maxScore: c.maxScore,
  }));
}

/** Strict enough to catch a copied blank template while preserving substantive reports. */
const TEMPLATE_COPY_SIMILARITY_THRESHOLD_PERCENT = 90;

type AiPerfTimings = {
  readiness: number;
  preflight: number;
  evaluation: number;
  postprocess: number;
  persistence: number;
};

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function logAiPerformance(
  reportId: string,
  timings: AiPerfTimings,
  totalStartedAt: number,
  outcome: string
) {
  console.info(
    `[AI PERF] report=${reportId} readiness=${timings.readiness}ms preflight=${timings.preflight}ms evaluation=${timings.evaluation}ms postprocess=${timings.postprocess}ms persistence=${timings.persistence}ms total=${elapsedMs(totalStartedAt)}ms outcome=${outcome}`
  );
}

/** Older records may contain the local view URL; extractors require the object key. */
function toStorageKey(fileUrl: string): string {
  const localStorageMarker = "/api/local-storage/";
  const markerIndex = fileUrl.indexOf(localStorageMarker);
  if (markerIndex >= 0) return fileUrl.slice(markerIndex + localStorageMarker.length);

  try {
    const parsed = new URL(fileUrl);
    return parsed.pathname.replace(/^\/+/, "");
  } catch {
    return fileUrl;
  }
}

async function applyTemplateCopyGuard(
  evaluation: Awaited<ReturnType<typeof evaluateReport>>,
  templateFileUrl: string | undefined,
  reportText: string
) {
  if (!templateFileUrl) return evaluation;

  try {
    const storageKey = toStorageKey(templateFileUrl);
    const { markdown } = await getTextExtractor().extractFromStorageObject(storageKey);
    const similarity = computeTextSimilarity(reportText, markdown);
    if (similarity < TEMPLATE_COPY_SIMILARITY_THRESHOLD_PERCENT) return evaluation;

    return {
      ...evaluation,
      headingContentAnalysis: evaluation.headingContentAnalysis.map((item) => ({
        ...item,
        contentMatchesExpectation: false,
        notes: `${item.notes} Rapor, boş şablonla çok yüksek benzerlik gösteriyor; bu bölümde yarışmacıya özgü içerik doğrulanamadı.`,
      })),
      templateAnalysis: {
        ...evaluation.templateAnalysis,
        compliant: false,
        notes:
          "Rapor, doldurulmamış rapor şablonunun kopyası gibi görünüyor; yarışmacıya özgü somut içerik bulunamadı.",
      },
    };
  } catch (error) {
    console.error(`Rapor şablonu kopya kontrolü başarısız (şablon ${templateFileUrl}):`, error);
    return evaluation;
  }
}

/**
 * A verified unrelated report must never spend a full model call generating
 * scores that will be discarded. Unevaluated compliance dimensions stay
 * neutral; category relevance is not a specification or template violation.
 */
function createRelevanceBlockedEvaluation(
  input: EvaluationInput,
  relevanceAnalysis: RelevanceAnalysis
): EvaluationOutput {
  const reason =
    "Doğrulanmış kategori/problem uyumsuzluğu nedeniyle normal AI puanlaması durduruldu.";

  return {
    languageAnalysis: {
      detectedLanguage: "Bilinmiyor",
      confidence: 0,
      summary: "Kategori/problem uygunluğu ön kontrolünde normal dil değerlendirmesi yapılmadı.",
      issues: [],
    },
    specificationAnalysis: {
      compliant: true,
      findings: [],
      notes: "Kategori/problem uyumsuzluğu nedeniyle şartname uygunluğu değerlendirilmedi.",
    },
    templateAnalysis: {
      compliant: true,
      missingSections: [],
      notes: "Kategori/problem uyumsuzluğu nedeniyle şablon uygunluğu değerlendirilmedi.",
    },
    headingContentAnalysis: input.template.sections.map((section) => ({
      sectionId: section.id,
      headingPresent: false,
      contentMatchesExpectation: false,
      notes: "Kategori/problem uygunluğu doğrulanmadan bölüm içeriği değerlendirilmedi.",
    })),
    categoryFit: { fit: false, reason: relevanceAnalysis.explanation },
    relevanceAnalysis,
    overallComplianceStatus: "needs_review",
    criteriaEvaluations: input.evaluationCriteria.map((criterion) => ({
      criterionId: criterion.id,
      score: null,
      scoreUnavailableReason: "relevance_blocked",
      reason,
    })),
    strengths: [],
    areasForImprovement: [],
    recommendations: [],
    similarReports: [],
    evidences: [],
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireRole("admin", "judge");
  if (!session) {
    return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });
  }

  const { id } = await params;
  const force = new URL(req.url).searchParams.get("force") === "true";
  const totalStartedAt = performance.now();
  const readinessStartedAt = performance.now();
  const timings: AiPerfTimings = {
    readiness: 0,
    preflight: 0,
    evaluation: 0,
    postprocess: 0,
    persistence: 0,
  };
  const reportRepository = getReportRepository();
  const report = await reportRepository.findById(id);
  if (!report) {
    timings.readiness = elapsedMs(readinessStartedAt);
    logAiPerformance(id, timings, totalStartedAt, "not_found");
    return NextResponse.json({ error: "Rapor bulunamadı." }, { status: 404 });
  }

  // Hakem yalnızca kendisine atanmış raporu değerlendirebilir; admin her raporu tetikleyebilir.
  if (session.user.role === "judge" && !report.assignedJudgeIds.includes(session.user.id)) {
    timings.readiness = elapsedMs(readinessStartedAt);
    logAiPerformance(id, timings, totalStartedAt, "forbidden");
    return NextResponse.json({ error: "Bu rapor size atanmamış." }, { status: 403 });
  }

  // AI kriterleri, hakemin raporu puanlarken kullandığı TAM AYNI kaynaktan
  // gelir (getEffectiveCriteria: kategoriye özel Category.criteria varsa o,
  // yoksa global ScoreCriterion listesi) — ayrı, kullanıcının göremediği bir
  // evaluationCriteria alanı artık zorunlu değil. templateSections de admin
  // panelinde ayrıca elle girilmiyor — gerçek kaynak admin'in zaten yüklediği
  // Rapor Şablonu PDF'idir. Bu hazırlık kontrolleri /copilot ile tek kaynaktan
  // (resolveReadiness) paylaşılır — mesajlar iki yerde de aynı kalır.
  const globalCriteria = await getScoreCriteriaRepository().listAll();
  const readiness = await resolveReadiness(report, globalCriteria);
  timings.readiness = elapsedMs(readinessStartedAt);

  if (readiness.status === "missing_text") {
    logAiPerformance(id, timings, totalStartedAt, readiness.status);
    return NextResponse.json({ error: readiness.message }, { status: 409 });
  }
  if (readiness.status === "category_not_found") {
    logAiPerformance(id, timings, totalStartedAt, readiness.status);
    return NextResponse.json({ error: readiness.message }, { status: 404 });
  }
  if (readiness.status === "missing_template" || readiness.status === "missing_criteria") {
    logAiPerformance(id, timings, totalStartedAt, readiness.status);
    return NextResponse.json({ error: readiness.message }, { status: 409 });
  }

  // Fresh sonuç hem admin hem hakem için aynı kalıcı AIAnalysis kaydıdır.
  // İstemcilerin cache kontrolünü atladığı doğrudan/tekrarlı POST'larda da
  // Cloudflare'e gereksiz ikinci bir çağrı göndermeyiz. Yalnızca kullanıcının
  // açık yeniden-çalıştırma niyetini taşıyan ?force=true bu kısa devreyi
  // bypass eder. Stale ve henüz başlamamış analizler force gerektirmeden
  // aşağıdaki gerçek pipeline'da yeniden üretilir.
  if (!force && readiness.status === "fresh" && report.aiEvaluation) {
    logAiPerformance(id, timings, totalStartedAt, "cache_hit");
    return NextResponse.json({ success: true, evaluation: report.aiEvaluation, cached: true });
  }

  const { category, effectiveCriteria } = readiness;

  const hasSpecification = Boolean(category.specificationText?.trim());
  const authoritativeSpecificationRules = buildAuthoritativeSpecificationRules(
    category.specificationText
  );

  let postprocessStartedAt: number | null = null;
  let postprocessFinished = false;

  try {
    const evaluationInput: EvaluationInput = {
      reportContent: toPageMarkedContent(report),
      category: category.name,
      // Kategori uygunluğu (categoryFit) yalnızca kategori adına dayanmasın —
      // admin bir açıklama girdiyse gerçek bağlamı da AI'ya verilir.
      categoryDescription: category.description,
      reportTitle: report.title,
      specificationContent: category.specificationText ?? undefined,
      specificationRules: authoritativeSpecificationRules.map(({ id, text, sourceLabel }) => ({
        id,
        text,
        sourceLabel,
      })),
      template: { sections: category.templateSections },
      evaluationCriteria: toAiCriteria(effectiveCriteria),
    };

    // Relevance is a bounded preflight. Only a verified, high-confidence
    // unrelated result blocks scoring; uncertainty proceeds to full analysis.
    let preflight: RelevanceAnalysis | undefined;
    if (hasSpecification) {
      const preflightStartedAt = performance.now();
      try {
        preflight = validateRelevanceAnalysis(
          await evaluateRelevancePreflight(evaluationInput),
          authoritativeSpecificationRules,
          report.extractedPages
        );
      } finally {
        timings.preflight = elapsedMs(preflightStartedAt);
      }
    }

    let evaluation: EvaluationOutput;
    if (preflight?.status === "unrelated") {
      evaluation = createRelevanceBlockedEvaluation(evaluationInput, preflight);
    } else {
      const evaluationStartedAt = performance.now();
      try {
        evaluation = await evaluateReport(evaluationInput);
      } finally {
        timings.evaluation = elapsedMs(evaluationStartedAt);
      }
    }

    if (preflight) evaluation.relevanceAnalysis = preflight;

    postprocessStartedAt = performance.now();

    validateCriteriaEvaluations(evaluation.criteriaEvaluations, effectiveCriteria);

    // Şartname yüklenmemişse, AI prompt'a "ihlal uydurma" talimatı verilmiş
    // olsa da bu bir garanti değildir — sunucu tarafı invariant: şartname
    // yoksa AI ne döndürürse döndürsün specificationAnalysis güvenli/nötr
    // bir sonuca sabitlenir (persistence'tan ÖNCE). Admin şartname
    // yüklemediği için yarışmacı bu yüzden asla "ihlal etmiş" sayılamaz.
    evaluation.specificationAnalysis = normalizeSpecificationAnalysis(
      evaluation.specificationAnalysis,
      hasSpecification,
      evaluation.languageAnalysis
    );
    evaluation.languageAnalysis = reconcileLanguageCompliance(
      evaluation.languageAnalysis,
      category.specificationText
    );
    if (hasSpecification) {
      const validatedSpecification = validateSpecificationFindings(
        evaluation.specificationAnalysis,
        authoritativeSpecificationRules,
        report.extractedPages
      );
      evaluation.specificationAnalysis = validatedSpecification.analysis;
      evaluation.areasForImprovement = [
        ...new Set([
          ...evaluation.areasForImprovement,
          ...validatedSpecification.technicalWeaknesses,
        ]),
      ];
      evaluation.relevanceAnalysis = validateRelevanceAnalysis(
        evaluation.relevanceAnalysis,
        authoritativeSpecificationRules,
        report.extractedPages
      );
      if (evaluation.relevanceAnalysis.status === "unrelated") {
        evaluation.criteriaEvaluations = evaluation.criteriaEvaluations.map((criterion) => ({
          ...criterion,
          score: null,
          scoreUnavailableReason: "relevance_blocked",
          reason:
            "Doğrulanmış kategori/problem uyumsuzluğu nedeniyle normal kriter puanlaması durduruldu.",
          evidence: undefined,
          pageNumber: undefined,
          exactExcerpt: undefined,
        }));
      }
    }

    const relevanceBlocked = evaluation.relevanceAnalysis?.status === "unrelated";
    const guardedEvaluation = relevanceBlocked
      ? evaluation
      : await applyTemplateCopyGuard(
          evaluation,
          category.reportTemplate?.fileUrl,
          report.extractedText ?? ""
        );

    const normalizedHeadings = normalizeHeadingContentAnalysis(
      category.templateSections,
      guardedEvaluation.headingContentAnalysis
    );
    guardedEvaluation.headingContentAnalysis = normalizedHeadings.items;

    // Sunucu, AI'nın söylediği pageNumber/exactExcerpt'e körü körüne
    // güvenmez — her iddiayı raporun gerçek sayfa metnine karşı doğrular ve
    // doğrulanamayanları sonuçtan çıkarır (bkz. postprocess.ts).
    const verifiedEvaluation = attachVerifiedEvidence(guardedEvaluation, report.extractedPages);
    if (!relevanceBlocked) {
      verifiedEvaluation.templateAnalysis = deriveTemplateCompliance(
        category.templateSections,
        verifiedEvaluation.headingContentAnalysis,
        verifiedEvaluation.templateAnalysis.notes,
        normalizedHeadings.issues
      );
    }
    const relevanceStatus = verifiedEvaluation.relevanceAnalysis?.status ?? "relevant";
    verifiedEvaluation.overallComplianceStatus =
      relevanceStatus !== "relevant"
        ? "needs_review"
        : !verifiedEvaluation.templateAnalysis.compliant || !verifiedEvaluation.specificationAnalysis.compliant
          ? "non_compliant"
          : verifiedEvaluation.languageAnalysis.issues.length > 0
            ? "needs_review"
            : "compliant";
    // criterionId yalnızca bir id'dir (genelde UUID) — UI'nın gösterebileceği
    // gerçek kriter adı/maxScore'u, hakemin puanlarken kullandığı AYNI
    // effectiveCriteria listesinden burada damgalanır (LLM üretmez).
    const criteriaById = new Map(effectiveCriteria.map((c) => [c.id, c]));
    verifiedEvaluation.criteriaEvaluations = verifiedEvaluation.criteriaEvaluations.map((c) => ({
      ...c,
      criterionLabel: criteriaById.get(c.criterionId)?.label,
      criterionMaxScore: criteriaById.get(c.criterionId)?.maxScore,
      ...(c.score != null && c.score > 0 && !(c.pageNumber && c.exactExcerpt)
        ? {
            score: null,
            scoreUnavailableReason: "evidence_unverified",
            reason: "Pozitif kriter puanı için doğrulanmış rapor kanıtı bulunamadı.",
          }
        : {}),
    }));

    // Benzerlik LLM tarafından üretilmez — deterministik olarak burada
    // hesaplanır ve aynı AI analiz kaydına (AIAnalysis) eklenir. Yalnızca
    // aynı kategorideki, extractedText'i dolu, kendisi olmayan raporlarla
    // karşılaştırılır (bkz. src/lib/ai-evaluation/similarity.ts).
    const allReports = await reportRepository.listAll();
    const candidates = allReports.filter(
      (r) => r.categoryId === report.categoryId && Boolean(r.extractedText)
    );
    const similarReports = findSimilarReports(
      { id: report.id, extractedText: report.extractedText ?? "", pages: report.extractedPages },
      candidates.map((r) => ({
        id: r.id,
        title: r.title,
        extractedText: r.extractedText ?? "",
        pages: r.extractedPages,
      }))
    );

    // Bu analiz hangi şartname/şablon/kriter kombinasyonuyla üretildi —
    // admin bunlardan birini değiştirirse GET /api/reports bu hash'i güncel
    // durumla karşılaştırıp analizi stale olarak işaretler (bkz. context-hash.ts).
    const contextHash = computeContextHash({
      specificationText: category.specificationText,
      templateSections: category.templateSections,
      criteria: effectiveCriteria,
    });

    const enrichedEvaluation = {
      ...verifiedEvaluation,
      similarReports,
      similarityScore: similarReports[0]?.matchPercentage,
      contextHash,
      evaluationPolicyVersion: EVALUATION_POLICY_VERSION,
    };

    timings.postprocess = elapsedMs(postprocessStartedAt);
    postprocessFinished = true;

    const persistenceStartedAt = performance.now();
    try {
      await reportRepository.setAiEvaluation(report.id, enrichedEvaluation);
      if (report.status === "assigned") {
        await reportRepository.setStatus(report.id, "in_review");
      }
    } finally {
      timings.persistence = elapsedMs(persistenceStartedAt);
    }

    logAiPerformance(id, timings, totalStartedAt, "success");
    return NextResponse.json({ success: true, evaluation: enrichedEvaluation });
  } catch (error) {
    if (postprocessStartedAt !== null && !postprocessFinished) {
      timings.postprocess = elapsedMs(postprocessStartedAt);
    }

    if (error instanceof InvalidCriteriaEvaluationsError) {
      logAiPerformance(id, timings, totalStartedAt, "invalid_criteria");
      return NextResponse.json(
        { error: "Geçersiz kriter değerlendirmesi.", details: error.message },
        { status: 400 }
      );
    }
    if (error instanceof z.ZodError) {
      logAiPerformance(id, timings, totalStartedAt, "invalid_input");
      return NextResponse.json(
        { error: "Geçersiz değerlendirme girdisi.", issues: error.issues },
        { status: 400 }
      );
    }
    if (error instanceof CloudflareAiTimeoutError) {
      logAiPerformance(id, timings, totalStartedAt, "timeout");
      console.error(`AI değerlendirme zaman aşımı (report ${report.id}).`);
      const cacheNote = report.aiEvaluation ? " Mevcut başarılı analiz korundu." : "";
      return NextResponse.json(
        {
          error: `AI sağlayıcısı 90 saniye içinde yanıt veremedi.${cacheNote} Lütfen tekrar deneyin.`,
        },
        { status: 504 }
      );
    }

    logAiPerformance(id, timings, totalStartedAt, "error");
    console.error(`AI değerlendirme hatası (report ${report.id}):`, error);
    return NextResponse.json({ error: "AI değerlendirmesi başarısız oldu." }, { status: 500 });
  }
}
