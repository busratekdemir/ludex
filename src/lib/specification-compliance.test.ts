import { describe, expect, it } from "vitest";
import {
  buildAuthoritativeSpecificationRules,
  normalizeSpecificationAnalysis,
  NO_SPECIFICATION_NOTES,
  validateRelevanceAnalysis,
  validateSpecificationFindings,
  reconcileLanguageCompliance,
} from "./specification-compliance";

const FAKE_SPEC_VIOLATION = {
  compliant: false,
  findings: [
    {
      ruleText: "Şartname yüklenmelidir.",
      findingText: "Şartname henüz yüklenmemiştir.",
      severity: "high" as const,
    },
  ],
  notes: "Şartname bulunamadı.",
};

const REAL_SPEC_VIOLATION = {
  compliant: false,
  findings: [
    {
      ruleText: "En az iki bağımsız sensör kullanılmalıdır.",
      findingText: "Rapor tek sensör kullanıyor.",
      severity: "high" as const,
    },
  ],
  notes: "Şartnameye aykırı bir durum tespit edildi.",
};

describe("normalizeSpecificationAnalysis", () => {
  const TURKISH_LANGUAGE_ANALYSIS = {
    detectedLanguage: "Türkçe",
    confidence: 0.95,
    summary: "Rapor Türkçe yazılmış.",
    issues: [],
  };

  it("removes a high-severity language contradiction when the detected language matches the rule", () => {
    const result = normalizeSpecificationAnalysis(
      {
        compliant: false,
        findings: [
          {
            ruleText: "Rapor, şartnamede belirtilen Türkçe dilinde yazılmalıdır.",
            findingText: "Raporun dili şartnameye uygun değildir.",
            severity: "high" as const,
          },
        ],
        notes: "Dil kuralı ihlal edildi.",
      },
      true,
      TURKISH_LANGUAGE_ANALYSIS
    );

    expect(result).toEqual({
      compliant: true,
      findings: [],
      notes: "Dil kuralı ihlal edildi.",
    });
  });

  it("keeps a language finding when detection contradicts the rule", () => {
    const result = normalizeSpecificationAnalysis(
      {
        compliant: false,
        findings: [
          {
            ruleText: "Rapor, şartnamede belirtilen Türkçe dilinde yazılmalıdır.",
            findingText: "Rapor İngilizce yazılmıştır.",
            severity: "high" as const,
          },
        ],
        notes: "Dil kuralı ihlal edildi.",
      },
      true,
      { ...TURKISH_LANGUAGE_ANALYSIS, detectedLanguage: "İngilizce" }
    );

    expect(result.findings).toHaveLength(1);
    expect(result.compliant).toBe(false);
  });

  it("removes only the contradictory language finding and keeps unrelated high findings", () => {
    const result = normalizeSpecificationAnalysis(
      {
        compliant: false,
        findings: [
          {
            ruleText: "Rapor Türkçe dilinde yazılmalıdır.",
            findingText: "Dil kuralı ihlal edildi.",
            severity: "high" as const,
          },
          {
            ruleText: "En az iki bağımsız sensör kullanılmalıdır.",
            findingText: "Rapor tek sensör kullanıyor.",
            severity: "high" as const,
          },
        ],
        notes: "İki ihlal bulundu.",
      },
      true,
      TURKISH_LANGUAGE_ANALYSIS
    );

    expect(result.compliant).toBe(false);
    expect(result.findings).toEqual([
      {
        ruleText: "En az iki bağımsız sensör kullanılmalıdır.",
        findingText: "Rapor tek sensör kullanıyor.",
        severity: "high",
      },
    ]);
  });

  // A) specificationText undefined (hiç şartname yok)
  it("forces a safe/neutral result when there is no specification, even if the AI fabricated a violation", () => {
    const result = normalizeSpecificationAnalysis(FAKE_SPEC_VIOLATION, false);

    expect(result).toEqual({ compliant: true, findings: [], notes: NO_SPECIFICATION_NOTES });
  });

  // B) specificationText boş string — aynı davranış (hasSpecification hesaplanırken
  // zaten false'a düşer, ama helper'ın kendisi de false için aynı şekilde davranmalı)
  it("behaves identically regardless of why hasSpecification is false (empty string case included at the caller)", () => {
    const result = normalizeSpecificationAnalysis(FAKE_SPEC_VIOLATION, false);
    expect(result.compliant).toBe(true);
    expect(result.findings).toEqual([]);
  });

  // C) gerçek specificationText varsa AI'nın gerçek violation finding'i korunmalı
  it("leaves a real specification analysis completely untouched when a specification exists", () => {
    const result = normalizeSpecificationAnalysis(REAL_SPEC_VIOLATION, true);

    expect(result).toBe(REAL_SPEC_VIOLATION);
    expect(result).toEqual(REAL_SPEC_VIOLATION);
  });

  it("does not mutate the input object", () => {
    const input = { ...FAKE_SPEC_VIOLATION };
    normalizeSpecificationAnalysis(input, false);
    expect(input).toEqual(FAKE_SPEC_VIOLATION);
  });
});

describe("reconcileLanguageCompliance", () => {
  const detected = (detectedLanguage: string, confidence = 0.9, issues = ["AI uyarısı"]) => ({
    detectedLanguage,
    confidence,
    summary: "ok",
    issues,
  });

  it("removes contradictory high-confidence Turkish and English warnings", () => {
    const screenshotRule = "Rapor, şartnamede belirtilen Türkçe dilinde yazılmalıdır.";
    expect(reconcileLanguageCompliance(detected("Türkçe"), screenshotRule).issues).toEqual([]);
    expect(reconcileLanguageCompliance(detected("Türkçe", 90), screenshotRule).issues).toEqual([]);
    expect(reconcileLanguageCompliance(detected("en"), "The report must be written in English.").issues).toEqual([]);
  });

  it("keeps a genuine language mismatch and treats aliases as equal", () => {
    expect(reconcileLanguageCompliance(detected("English"), "Rapor Türkçe dilinde yazılmalıdır.").issues).not.toEqual([]);
    expect(reconcileLanguageCompliance(detected("tr"), "Rapor Türkçe dilinde yazılmalıdır.").issues).toEqual([]);
  });

  it("keeps low-confidence detection as neutral review", () => {
    expect(reconcileLanguageCompliance(detected("Türkçe", 0.5, []), "Rapor Türkçe dilinde yazılmalıdır.").issues).not.toEqual([]);
  });
});

describe("validateSpecificationFindings", () => {
  const specification = `Rapor iki bağımsız sensör içermelidir.

Bu koşulu sağlamayan başvurular diskalifiye edilir.`;
  const rules = buildAuthoritativeSpecificationRules(specification);
  const pages = [{ pageNumber: 1, text: "Rapor yalnızca tek sensör kullanıyor." }];
  const finding = (overrides = {}) => ({
    ruleId: rules[0].id,
    ruleText: rules[0].text,
    findingText: "Rapor yalnızca tek sensör kullanıyor.",
    severity: "high" as const,
    classification: "requirement" as const,
    pageNumber: 1,
    exactExcerpt: "tek sensör kullanıyor",
    ...overrides,
  });

  it("downgrades performance weaknesses without an explicit rule to improvement notes", () => {
    const weakness =
      "Alternatif güzergâh seçeneklerinin demo veri setinde sınırlı olması nedeniyle rota iyileşmesi hedefin altında kaldı.";
    const result = validateSpecificationFindings(
      {
        compliant: false,
        notes: "not",
        findings: [finding({ ruleId: "unknown", findingText: weakness, exactExcerpt: "tek sensör kullanıyor" })],
      },
      rules,
      pages
    );
    expect(result.analysis.findings).toEqual([]);
    expect(result.analysis.compliant).toBe(true);
    expect(result.technicalWeaknesses).toEqual([weakness]);
  });

  it("rejects a circular AI rule copied from the report finding", () => {
    const result = validateSpecificationFindings(
      { compliant: false, notes: "not", findings: [finding({ ruleText: "Rapor yalnızca tek sensör kullanıyor." })] },
      rules,
      pages
    );
    expect(result.analysis.findings).toEqual([]);
  });

  it("keeps a valid authoritative mandatory requirement as a requirement gap", () => {
    const result = validateSpecificationFindings(
      { compliant: false, notes: "not", findings: [finding()] },
      rules,
      pages
    );
    expect(result.analysis.findings[0]).toEqual(
      expect.objectContaining({ ruleId: rules[0].id, ruleText: rules[0].text, classification: "requirement" })
    );
  });

  it("allows disqualification classification only for an explicitly disqualifying source rule", () => {
    const result = validateSpecificationFindings(
      {
        compliant: false,
        notes: "not",
        findings: [
          finding({
            ruleId: rules[1].id,
            ruleText: rules[1].text,
            classification: "disqualification",
          }),
        ],
      },
      rules,
      pages
    );
    expect(result.analysis.findings[0].classification).toBe("disqualification");
  });

  it("deduplicates repeated valid violations", () => {
    const result = validateSpecificationFindings(
      { compliant: false, notes: "not", findings: [finding(), finding()] },
      rules,
      pages
    );
    expect(result.analysis.findings).toHaveLength(1);
  });
});

describe("validateRelevanceAnalysis", () => {
  const rules = buildAuthoritativeSpecificationRules(
    "İHA, otonom uçuş görevi için tasarlanmalıdır."
  );
  const pages = [{ pageNumber: 1, text: "Projemiz sera sulama sistemini otomatikleştirir." }];
  const unrelated = (overrides = {}) => ({
    status: "unrelated" as const,
    specificationRuleIds: [rules[0].id],
    reportPageNumber: 1,
    reportExcerpt: "sera sulama sistemini otomatikleştirir",
    explanation: "Rapor farklı bir problemi çözüyor.",
    confidence: 0.95,
    mappedConcepts: ["sulama"],
    ...overrides,
  });

  it("keeps unrelated only with verified rule/report evidence and high confidence", () => {
    expect(validateRelevanceAnalysis(unrelated(), rules, pages).status).toBe("unrelated");
  });

  it("downgrades low-confidence unrelated evidence to uncertain", () => {
    expect(
      validateRelevanceAnalysis(unrelated({ confidence: 0.79 }), rules, pages).status
    ).toBe("uncertain");
  });

  it("downgrades an unverifiable exact excerpt to uncertain and removes it", () => {
    const result = validateRelevanceAnalysis(
      unrelated({ reportExcerpt: "Raporda olmayan alıntı" }),
      rules,
      pages
    );
    expect(result).toMatchObject({
      status: "uncertain",
      confidence: 0,
      reportPageNumber: undefined,
      reportExcerpt: undefined,
    });
  });
});
