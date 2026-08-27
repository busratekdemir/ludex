import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryRecord } from "@/lib/repositories/category-repository";
import type { ReportRecord } from "@/lib/repositories/report-repository";

const { findCategory, deriveTemplateSections } = vi.hoisted(() => ({
  findCategory: vi.fn(),
  deriveTemplateSections: vi.fn(),
}));

vi.mock("@/lib/repositories/category-repository", () => ({
  getCategoryRepository: () => ({ findById: findCategory, setTemplateSections: vi.fn() }),
}));

vi.mock("@/lib/text-extraction/report-template", () => ({
  deriveTemplateSectionsFromStorageKey: deriveTemplateSections,
}));

import { resolveReadiness } from "./readiness";

const REPORT: ReportRecord = {
  id: "report-1",
  title: "Rapor",
  contestantId: "contestant-1",
  categoryId: "category-1",
  fileName: "report.pdf",
  fileSizeBytes: 100,
  r2Key: "reports/report.pdf",
  status: "assigned",
  extractedText: "Rapor içeriği.",
  extractedPages: [{ pageNumber: 1, text: "Rapor içeriği." }],
  aiEvaluation: null,
  assignedJudgeIds: ["judge-1"],
  submittedAt: "2026-08-27T00:00:00.000Z",
};

function category(criteria: CategoryRecord["criteria"]): CategoryRecord {
  return {
    id: "category-1",
    name: "Kategori",
    slug: "kategori",
    createdAt: "2026-08-27T00:00:00.000Z",
    criteria,
    specificationText: null,
    templateSections: [{ id: "section-1", title: "Özet", expectedContent: "Amaç." }],
    evaluationCriteria: [],
  };
}

beforeEach(() => {
  findCategory.mockReset();
  deriveTemplateSections.mockReset();
});

describe("resolveReadiness — effective judge criteria", () => {
  const globalCriteria = [
    { id: "global-1", label: "Global Kriter", description: "Global açıklama", maxScore: 10 },
  ];
  const categoryCriteria = [
    { id: "category-1", label: "Kategori Kriteri", description: "Kategori açıklaması", maxScore: 15 },
  ];

  it("uses category-specific admin criteria instead of global criteria", async () => {
    findCategory.mockResolvedValue(category(categoryCriteria));

    const result = await resolveReadiness(REPORT, globalCriteria);

    expect(result).toMatchObject({
      status: "ready_not_started",
      effectiveCriteria: categoryCriteria,
    });
  });

  it("falls back to global criteria only when category-specific criteria are empty", async () => {
    findCategory.mockResolvedValue(category([]));

    const result = await resolveReadiness(REPORT, globalCriteria);

    expect(result).toMatchObject({
      status: "ready_not_started",
      effectiveCriteria: globalCriteria,
    });
  });
});
