import type { LanguageAnalysis } from "@/lib/ai-evaluation/schema";
import type { SpecificationAnalysis, SpecificationFinding } from "@/lib/ai-evaluation/schema";
import type { RelevanceAnalysis } from "@/lib/ai-evaluation/schema";
import { verifyExcerpt } from "@/lib/ai-evaluation/evidence";
import type { ExtractedPage } from "@/lib/text-extraction/extractor";

export interface AuthoritativeSpecificationRule {
  id: string;
  text: string;
  sourceLabel: string;
  explicitlyDisqualifying: boolean;
}

export interface NormalizableSpecificationAnalysis {
  compliant: boolean;
  findings: unknown[];
  notes: string;
}

export const NO_SPECIFICATION_NOTES =
  "Şartname yüklenmediği için şartname uygunluğu değerlendirilmedi.";

/** An unrelated hard block requires both verified evidence and high model confidence. */
export const UNRELATED_RELEVANCE_MIN_CONFIDENCE = 0.8;

const LANGUAGE_ALIASES: Record<string, string> = {
  tr: "tr", turkish: "tr", turkce: "tr",
  en: "en", english: "en",
  de: "de", german: "de", deutsch: "de",
  fr: "fr", french: "fr", francais: "fr",
  es: "es", spanish: "es", espanol: "es",
};

export function canonicalLanguage(value: string): string | null {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return LANGUAGE_ALIASES[normalized] ?? (normalized.length === 2 ? normalized : null);
}

/** Deterministically reconciles a stated specification language with detection. */
export function reconcileLanguageCompliance(
  languageAnalysis: LanguageAnalysis,
  specificationText: string | null | undefined
): LanguageAnalysis {
  const confidence = languageAnalysis.confidence > 1 ? languageAnalysis.confidence / 100 : languageAnalysis.confidence;
  const text = specificationText ?? "";
  const match =
    text.match(/([\p{L}-]{2,30})\s+dilinde/iu) ??
    text.match(/(?:language|dil|written)[^\n.]{0,80}?\b(?:in|as)\s+([\p{L}-]{2,30})/iu);
  const required = canonicalLanguage(match?.[1] ?? "");
  const detected = canonicalLanguage(languageAnalysis.detectedLanguage);
  if (!required || !detected) return languageAnalysis;
  if (required === detected && confidence >= 0.8) {
    return { ...languageAnalysis, confidence, issues: [] };
  }
  if (confidence < 0.8) {
    return {
      ...languageAnalysis,
      confidence,
      issues: languageAnalysis.issues.length ? languageAnalysis.issues : ["Dil tespiti düşük güvenlidir; hakem incelemesi gerekir."],
    };
  }
  return languageAnalysis;
}

function comparableText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("tr-TR");
}

/** Stable server-issued references for the active specification's substantive blocks. */
export function buildAuthoritativeSpecificationRules(
  specificationText: string | null | undefined
): AuthoritativeSpecificationRule[] {
  const blocks = (specificationText ?? "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.replace(/[^\p{L}\p{N}]/gu, "").length >= 12);

  return blocks.map((text, index) => ({
    id: `spec-rule-${index + 1}`,
    text,
    sourceLabel: `Şartname bölüm ${index + 1}`,
    explicitlyDisqualifying: /\b(disqualif\w*|eliminat\w*|reject\w*|ineligible|elenir|eleme|diskalifiye|reddedilir)\b/i.test(
      text
    ),
  }));
}

function isCopiedOrCircularRule(finding: SpecificationFinding): boolean {
  const rule = comparableText(finding.ruleText).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  const report = comparableText(finding.findingText).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!rule || !report) return true;
  if (rule === report || rule.includes(report) || report.includes(rule)) return true;
  const ruleWords = new Set(rule.split(/\s+/).filter((word) => word.length > 2));
  const reportWords = new Set(report.split(/\s+/).filter((word) => word.length > 2));
  if (ruleWords.size === 0 || reportWords.size === 0) return false;
  let shared = 0;
  for (const word of ruleWords) if (reportWords.has(word)) shared++;
  return shared / Math.min(ruleWords.size, reportWords.size) >= 0.8;
}

export interface ValidatedSpecificationAnalysis {
  analysis: SpecificationAnalysis;
  technicalWeaknesses: string[];
  rulesById: Map<string, AuthoritativeSpecificationRule>;
}

export function validateRelevanceAnalysis(
  relevance: RelevanceAnalysis | undefined,
  rules: AuthoritativeSpecificationRule[],
  reportPages: ExtractedPage[] | null | undefined
): RelevanceAnalysis {
  if (!relevance) {
    return {
      status: "uncertain",
      specificationRuleIds: [],
      explanation: "Kategori/problem eşleşmesi için doğrulanmış kanıt bulunamadı.",
      confidence: 0,
      mappedConcepts: [],
    };
  }
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const validRuleIds = relevance.specificationRuleIds.filter((id) => ruleIds.has(id));
  const reportEvidence = verifyExcerpt(reportPages, relevance.reportPageNumber, relevance.reportExcerpt);
  if (validRuleIds.length === 0 || !reportEvidence) {
    return {
      ...relevance,
      status: "uncertain",
      specificationRuleIds: validRuleIds,
      reportPageNumber: undefined,
      reportExcerpt: undefined,
      explanation: "Kategori/problem eşleşmesi için doğrulanmış şartname ve rapor kanıtı bulunamadı.",
      confidence: 0,
    };
  }
  if (
    relevance.status === "unrelated" &&
    relevance.confidence < UNRELATED_RELEVANCE_MIN_CONFIDENCE
  ) {
    return {
      ...relevance,
      status: "uncertain",
      specificationRuleIds: validRuleIds,
      reportPageNumber: reportEvidence.page,
      reportExcerpt: reportEvidence.excerpt,
      explanation:
        "Kategori/problem uyumsuzluğu için kanıt bulundu ancak güven düzeyi yetersiz; hakem incelemesi gerekiyor.",
    };
  }
  return {
    ...relevance,
    specificationRuleIds: validRuleIds,
    reportPageNumber: reportEvidence.page,
    reportExcerpt: reportEvidence.excerpt,
  };
}

/**
 * Converts only model claims tied to a server-issued rule ID into specification
 * findings. All unsupported/circular claims are downgraded to improvement notes.
 */
export function validateSpecificationFindings(
  specificationAnalysis: SpecificationAnalysis,
  rules: AuthoritativeSpecificationRule[],
  reportPages: ExtractedPage[] | null | undefined
): ValidatedSpecificationAnalysis {
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const technicalWeaknesses: string[] = [];
  const findings: SpecificationFinding[] = [];
  const seen = new Set<string>();

  for (const finding of specificationAnalysis.findings) {
    const rule = finding.ruleId ? rulesById.get(finding.ruleId) : undefined;
    const reportEvidence = verifyExcerpt(reportPages, finding.pageNumber, finding.exactExcerpt);
    const circular = isCopiedOrCircularRule(finding);
    if (!rule || !reportEvidence || circular) {
      technicalWeaknesses.push(finding.findingText);
      continue;
    }

    const classification =
      finding.classification === "disqualification" && rule.explicitlyDisqualifying
        ? "disqualification"
        : "requirement";
    const dedupeKey = `${rule.id}:${comparableText(finding.findingText)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    findings.push({
      ...finding,
      ruleId: rule.id,
      ruleText: rule.text,
      ruleSourceLabel: rule.sourceLabel,
      classification,
      pageNumber: reportEvidence.page,
      exactExcerpt: reportEvidence.excerpt,
    });
  }

  return {
    analysis: {
      ...specificationAnalysis,
      compliant: findings.length === 0,
      findings,
      notes:
        findings.length === 0
          ? "Doğrulanmış şartname ihlali bulunamadı."
          : specificationAnalysis.notes,
    },
    technicalWeaknesses: [...new Set(technicalWeaknesses)],
    rulesById,
  };
}

function isContradictoryLanguageFinding(
  finding: { ruleText: string },
  languageAnalysis: LanguageAnalysis
): boolean {
  if (languageAnalysis.confidence < 0.8) return false;

  const ruleText = comparableText(finding.ruleText);
  const detectedLanguage = comparableText(languageAnalysis.detectedLanguage.trim());
  if (!detectedLanguage || !ruleText.includes(detectedLanguage)) return false;

  // The detected language is used only as a consistency signal. The rule text
  // remains the source of the requirement; no language is globally assumed.
  return /\bdil\w*\b|\blanguage\w*\b|\byazil\w*\b|\bwritten\b/i.test(ruleText);
}

/** Removes only a high-confidence language finding that contradicts detection. */
export function normalizeLanguageContradictions<T extends NormalizableSpecificationAnalysis>(
  specificationAnalysis: T,
  languageAnalysis: LanguageAnalysis
): T {
  const findings = specificationAnalysis.findings.filter(
    (finding) =>
      !isContradictoryLanguageFinding(finding as { ruleText: string }, languageAnalysis)
  );

  if (findings.length === specificationAnalysis.findings.length) return specificationAnalysis;
  return {
    ...specificationAnalysis,
    compliant: findings.length === 0 ? true : specificationAnalysis.compliant,
    findings,
  };
}

/**
 * Admin bu kategori için henüz bir şartname yüklemediyse (hasSpecification
 * false), AI'nın specificationAnalysis için ne döndürdüğüne BAKILMAKSIZIN
 * sonucu güvenli/nötr bir duruma sabitler: compliant=true, findings=[],
 * notes="...değerlendirilmedi." — admin şartname yüklemediği için
 * yarışmacı bu yüzden asla "ihlal etmiş" sayılamaz.
 *
 * AI'nın ("Şartname yüklenmelidir" gibi) uydurduğu bir bulgu ne taze bir
 * analiz sonucunda ne de DB'de önceden kaydedilmiş (bu düzeltmeden önce
 * üretilmiş) eski bir AIAnalysis'te asla korunmamalı — bu yüzden bu
 * fonksiyon TEK bir yerden, hem sunucu tarafında (evaluate/route.ts —
 * persistence'tan ÖNCE) hem istemci tarafında (ai-analysis.service.ts —
 * hem taze POST yanıtı hem cache'lenmiş DB satırı okunurken) çağrılır;
 * ikisi de aynı kurala tabidir.
 */
export function normalizeSpecificationAnalysis<T extends NormalizableSpecificationAnalysis>(
  specificationAnalysis: T,
  hasSpecification: boolean,
  languageAnalysis?: LanguageAnalysis
): T {
  if (hasSpecification) {
    return languageAnalysis
      ? normalizeLanguageContradictions(specificationAnalysis, languageAnalysis)
      : specificationAnalysis;
  }
  return {
    ...specificationAnalysis,
    compliant: true,
    findings: [],
    notes: NO_SPECIFICATION_NOTES,
  };
}
