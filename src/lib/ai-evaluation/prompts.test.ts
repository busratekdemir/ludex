import { describe, expect, it } from "vitest";
import { evaluationInputSchema } from "./schema";
import { RELEVANCE_PREFLIGHT_SYSTEM_PROMPT, SYSTEM_PROMPT, buildEvaluationPrompt } from "./prompts";

const BASE_INPUT = {
  reportContent: "[PAGE 1]\nRapor içeriği.",
  category: "İnsansız Hava Aracı",
  template: {
    sections: [{ id: "sec-1", title: "Özet", expectedContent: "Projenin özeti." }],
  },
  evaluationCriteria: [
    { id: "crit-1", name: "Yenilikçilik", description: "Ne kadar yenilikçi?", maxScore: 10 },
  ],
};

describe("buildEvaluationPrompt — kategori bağlamı", () => {
  it("categoryDescription verildiğinde prompt'a dahil edilir", () => {
    const input = evaluationInputSchema.parse({
      ...BASE_INPUT,
      categoryDescription: "Bu kategori, otonom uçuş yapabilen insansız hava araçları içindir.",
    });

    const prompt = buildEvaluationPrompt(input);

    expect(prompt).toContain("KATEGORİ AÇIKLAMASI");
    expect(prompt).toContain("otonom uçuş yapabilen insansız hava araçları içindir");
  });

  it("categoryDescription verilmediğinde input hâlâ geçerlidir ve açıklama bloğu eklenmez", () => {
    const input = evaluationInputSchema.parse(BASE_INPUT);

    const prompt = buildEvaluationPrompt(input);

    expect(prompt).not.toContain("KATEGORİ AÇIKLAMASI");
    expect(prompt).toContain("İnsansız Hava Aracı");
  });

  it("does not duplicate specification text when authoritative rules are present", () => {
    const uniqueRuleText = "Rapor en az iki bağımsız sensör içermelidir.";
    const input = evaluationInputSchema.parse({
      ...BASE_INPUT,
      specificationContent: uniqueRuleText,
      specificationRules: [
        { id: "spec-rule-1", text: uniqueRuleText, sourceLabel: "Şartname bölüm 1" },
      ],
    });

    const prompt = buildEvaluationPrompt(input);
    expect(prompt.split(uniqueRuleText)).toHaveLength(2);
    expect(prompt).toContain("ruleId: spec-rule-1");
  });

  it("keeps the no-specification safety instruction", () => {
    const input = evaluationInputSchema.parse(BASE_INPUT);
    const prompt = buildEvaluationPrompt(input);

    expect(prompt).toContain("hiçbir ihlal bulgusu üretme");
  });

  it("defines uncertain as reviewable evidence insufficiency rather than compliance failure", () => {
    expect(SYSTEM_PROMPT).toContain("uncertain yalnızca kanıtın yetersiz olduğunu");
    expect(SYSTEM_PROMPT).toContain("normal kriter değerlendirmesini durdurmaz");
    expect(RELEVANCE_PREFLIGHT_SYSTEM_PROMPT).toContain("uncertain başarısızlık değil");
    expect(RELEVANCE_PREFLIGHT_SYSTEM_PROMPT).toContain("confidence en az 0.8");
  });
});
