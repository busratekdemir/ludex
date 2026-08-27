import type { EvaluationOutput } from "./schema";
import type { ExtractedPage } from "@/lib/text-extraction/extractor";
import { verifyExcerpt } from "./evidence";

export interface Evidence {
  id: string;
  page: number;
  excerpt: string;
  note?: string;
}

/**
 * Modele "HTML/Markdown" gibi bir biçimlendirme dili adını yalnızca gerçekten
 * geçiyorsa kullanması söylenir (bkz. prompts.ts), ama bu bir prompt talimatı
 * olduğu için garanti değildir — model yine de alışkanlıkla bu ifadeye
 * dönebilir. Bu, o talimatın kod tarafındaki kesin garantisidir: rapor
 * metninin çıkarılma biçimi (LlamaParse çıktısı zaten markdown'dur) hiçbir
 * zaman yarışmacının kendi kararı değildir, bu yüzden serbest metin
 * bulgularında "HTML"/"Markdown" adı geçen HER ifade, doğru olsa bile
 * yanıltıcıdır — koşulsuz olarak filtrelenir.
 */
const MARKUP_TECHNOLOGY_MENTION = /\b(html|markdown)\b/i;

function stripMarkupTechnologyMentions(items: string[]): string[] {
  return items.filter((item) => !MARKUP_TECHNOLOGY_MENTION.test(item));
}

/**
 * AI çıktısındaki her pageNumber/exactExcerpt iddiasını raporun gerçek sayfa
 * metnine karşı doğrular (bkz. evidence.ts). Doğrulanamayan bir alıntı,
 * persist edilen sonuçtan TAMAMEN çıkarılır (asla saklanmaz) — böylece
 * DB'de duran her pageNumber/exactExcerpt, garantili olarak gerçektir.
 * Kriter puanı/gerekçesi bu konum doğrulamasından bağımsızdır: doğrulanamayan
 * alıntı yalnızca tıklanabilir kanıtı kaldırır, geçerli puanı kaldırmaz.
 * Doğrulanan her alıntı, sabit id'li düz bir `evidences` listesine de
 * eklenir; bu id'ler UI'daki mevcut jumpToEvidence/highlight mekanizmasının
 * beklediği `Evidence{id,page,excerpt}` şeklidir.
 */
export function attachVerifiedEvidence(
  evaluation: EvaluationOutput,
  pages: ExtractedPage[] | null | undefined
): EvaluationOutput {
  const evidences: Evidence[] = [];
  const usedEvidenceIds = new Set<string>();
  const uniqueEvidenceId = (baseId: string): string => {
    let id = baseId;
    let suffix = 2;
    while (usedEvidenceIds.has(id)) id = `${baseId}-${suffix++}`;
    usedEvidenceIds.add(id);
    return id;
  };

  const specFindings = evaluation.specificationAnalysis.findings.map((finding, index) => {
    const verified = verifyExcerpt(pages, finding.pageNumber, finding.exactExcerpt);
    if (!verified) {
      return { ...finding, pageNumber: undefined, exactExcerpt: undefined };
    }
    const id = uniqueEvidenceId(`spec-${index}`);
    evidences.push({ id, page: verified.page, excerpt: verified.excerpt, note: finding.ruleText });
    return finding;
  });

  const headingContentAnalysis = evaluation.headingContentAnalysis.map((item) => {
    const verified = verifyExcerpt(pages, item.pageNumber, item.exactExcerpt);
    if (!verified) {
      return { ...item, pageNumber: undefined, exactExcerpt: undefined };
    }
    const id = uniqueEvidenceId(`heading-${item.sectionId}`);
    evidences.push({ id, page: verified.page, excerpt: verified.excerpt, note: item.notes });
    return item;
  });

  const criteriaEvaluations = evaluation.criteriaEvaluations.map((item) => {
    const verified = verifyExcerpt(pages, item.pageNumber, item.exactExcerpt);
    if (!verified) {
      return { ...item, pageNumber: undefined, exactExcerpt: undefined };
    }
    const id = uniqueEvidenceId(`criterion-${item.criterionId}`);
    evidences.push({ id, page: verified.page, excerpt: verified.excerpt, note: item.evidence });
    return item;
  });

  return {
    ...evaluation,
    specificationAnalysis: { ...evaluation.specificationAnalysis, findings: specFindings },
    headingContentAnalysis,
    criteriaEvaluations,
    strengths: stripMarkupTechnologyMentions(evaluation.strengths),
    areasForImprovement: stripMarkupTechnologyMentions(evaluation.areasForImprovement),
    recommendations: stripMarkupTechnologyMentions(evaluation.recommendations),
    evidences,
  };
}
