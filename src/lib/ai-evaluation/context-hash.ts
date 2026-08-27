import { createHash } from "crypto";
import type { CategoryTemplateSection } from "@/lib/repositories/category-repository";
import type { ScoreCriterion } from "@/types";

export interface ContextHashInput {
  specificationText: string | null;
  templateSections: CategoryTemplateSection[];
  criteria: ScoreCriterion[];
}

export const EVALUATION_POLICY_VERSION = 6;

/**
 * Bir kategorinin o anki AI değerlendirme bağlamının (şartname metni +
 * şablon bölümleri + efektif kriterler) parmak izi. Aynı girdi her zaman
 * aynı hash'i üretir; admin şartnameyi, şablonu veya kriterleri değiştirdiği
 * anda hash değişir. `/evaluate` bu hash'i üretilen analize damgalar,
 * `GET /api/reports` ise raporun categorisinin GÜNCEL hash'ini aynı
 * fonksiyonla yeniden hesaplayıp karşılaştırarak analizi stale sayar mı
 * karar verir — tek kaynak burası, iki yerde de aynı algoritma kullanılır.
 */
export function computeContextHash(input: ContextHashInput): string {
  const canonical = JSON.stringify({
    evaluationPolicyVersion: EVALUATION_POLICY_VERSION,
    specification: input.specificationText ?? "",
    template: input.templateSections.map((s) => ({
      id: s.id,
      title: s.title,
      expectedContent: s.expectedContent,
    })),
    criteria: input.criteria.map((c) => ({
      id: c.id,
      label: c.label,
      maxScore: c.maxScore,
      description: c.description ?? "",
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
