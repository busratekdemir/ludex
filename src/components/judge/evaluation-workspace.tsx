"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  AlertOctagon,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Flag,
  LayoutGrid,
  List,
  Loader2,
  Send,
  ShieldAlert,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { getEffectiveCriteria, useAppStore, useCurrentUser } from "@/store/useAppStore";
import * as evaluationsService from "@/services/evaluations.service";
import { refreshReports, refreshEvaluations, refreshScoreCriteria } from "@/services/sync";
import * as aiAnalysisService from "@/services/ai-analysis.service";
import * as copilotService from "@/services/copilot.service";
import { buildHighlightQuery, highlightTextItem } from "@/lib/pdf-highlight";
import {
  computeAiPreliminaryScore,
  computeOverallScoreDiff,
  hasCompleteJudgeScore,
} from "@/lib/ai-preliminary-score";
import { buildGateFindings, type GateFinding } from "@/lib/gate-findings";
import type {
  AIAnalysisResult,
  ComplianceCheckItem,
  CopilotChatMessage,
  CriterionAiEvaluation,
  DisqualificationRecommendation,
  Severity,
} from "@/types";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const SEVERITY_LABEL: Record<Severity, string> = { low: "Düşük", medium: "Orta", high: "Yüksek" };

const SEVERITY_CLASS: Record<Severity, string> = {
  low: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
  medium:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  high: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
};

/** ✅ uygun / ⚠ inceleme gerekli / ❌ sorun bulundu — gerçek backend verisine göre üç durumlu ikon. */
function ComplianceStatusIcon({ item }: { item: ComplianceCheckItem }) {
  if (item.passed) return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />;
  if (item.severity === "high") return <XCircle className="size-4 shrink-0 text-red-500" />;
  return <AlertTriangle className="size-4 shrink-0 text-amber-500" />;
}

function ComplianceRow({
  item,
  analysis,
  onEvidence,
  compact = false,
}: {
  item: ComplianceCheckItem;
  analysis: AIAnalysisResult;
  onEvidence: (id: string) => void;
  compact?: boolean;
}) {
  const showUnverifiable = item.unverifiable && item.evidenceIds.length === 0;

  if (compact) {
    return (
      <div className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
        <ComplianceStatusIcon item={item} />
        <p className="min-w-0 flex-1 truncate text-base font-medium">{item.label}</p>
        {item.evidenceIds.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto shrink-0 px-2 text-sm"
            onClick={() => onEvidence(item.evidenceIds[0])}
          >
            Kanıt
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1 rounded-lg bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-medium">{item.label}</p>
        <ComplianceStatusIcon item={item} />
      </div>
      <p className="text-base text-muted-foreground">{item.detail}</p>
      {item.evidenceIds.map((eid) => (
        <Button
          key={eid}
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-base"
          onClick={() => onEvidence(eid)}
        >
          Neden? (Sayfa {analysis.evidences.find((e) => e.id === eid)?.page})
        </Button>
      ))}
      {showUnverifiable && (
        <p className="text-sm italic text-muted-foreground">
          Bu bulgu belge içinde işaretlenemez; bölüm eksik.
        </p>
      )}
    </div>
  );
}

/**
 * Kriter bazlı AI değerlendirmesi satırı — AI'nın puan ÖNERİSİni (nihai puan
 * değil) ve gerekçesini açıkça gösterir. Hakem bu kriter için kendi puanını
 * zaten girdiyse (judgeScore tanımlıysa), aradaki farkı da gösterir — ama
 * hakem henüz dokunmadıysa (input hâlâ varsayılan 0 gösteriyor olsa da
 * `scores` state'inde bu kriter için hiç kayıt yoksa) fark GÖSTERİLMEZ; bu
 * karşılaştırma yalnızca hakemin fiilen girdiği bir puana dayanır.
 */
function CriterionEvaluationRow({
  item,
  analysis,
  onEvidence,
  judgeScore,
}: {
  item: CriterionAiEvaluation;
  analysis: AIAnalysisResult;
  onEvidence: (id: string) => void;
  judgeScore?: number;
}) {
  const diff = judgeScore != null && item.score != null ? judgeScore - item.score : null;
  const unavailableLabel =
    item.scoreUnavailableReason === "relevance_blocked"
      ? "Puanlama yapılmadı"
      : item.scoreUnavailableReason === "evidence_unverified"
        ? "Kriter kanıtı doğrulanamadı"
        : "Puan ölçeği tanımlı değil";

  return (
    <div className="space-y-1 rounded-lg bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-medium">{item.label}</p>
        {item.score != null ? (
          <span className="text-base font-semibold text-primary">
            AI önerisi: {item.score}
            {item.maxScore != null ? ` / ${item.maxScore}` : ""}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-sm text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0" />
            {unavailableLabel}
          </span>
        )}
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">Gerekçe</p>
        <p className="text-base text-muted-foreground">{item.reason}</p>
      </div>
      {item.evidenceIds.map((eid) => (
        <Button
          key={eid}
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-base"
          onClick={() => onEvidence(eid)}
        >
          Neden? (Sayfa {analysis.evidences.find((e) => e.id === eid)?.page})
        </Button>
      ))}
      {diff !== null && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-2 text-sm text-muted-foreground">
          <span>
            AI: {item.score} / {item.maxScore}
          </span>
          <span>
            Hakem: {judgeScore} / {item.maxScore}
          </span>
          <span
            className={
              diff === 0
                ? "text-muted-foreground"
                : diff > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
            }
          >
            Fark: {diff > 0 ? "+" : ""}
            {diff}
          </span>
        </div>
      )}
    </div>
  );
}

type AnalysisState =
  | "idle"
  | "checking"
  | "awaiting-decision"
  | "done"
  | "eliminated"
  | "error"
  | "stale";

/**
 * Tek bir Cloudflare structured-output çağrısında hep birlikte hesaplanan
 * gerçek alt analizler. Bunlar ayrı ayrı sunucuda bitmiş gibi sahte bir
 * ilerleme çubuğuyla gösterilmez — çağrı sürerken tamamı "bekleniyor" olarak
 * listelenir, sonuç geldiğinde her biri gerçek verisiyle (bkz. Aşama 1-7
 * accordion bölümleri) birlikte görünür.
 */
const ANALYSIS_CHECK_LABELS = [
  "Dil kontrolü",
  "Şartname uygunluğu",
  "Şablon uygunluğu",
  "Başlık ve içerik kontrolü",
  "Kategori uygunluğu",
  "Benzerlik analizi",
  "Kriter bazlı AI değerlendirmesi",
];

export function EvaluationWorkspace({ reportId }: { reportId: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  const report = useAppStore((s) => s.reports.find((r) => r.id === reportId)) ?? null;
  const categories = useAppStore((s) => s.categories);
  const globalScoreCriteria = useAppStore((s) => s.scoreCriteria);
  const evaluations = useAppStore((s) => s.evaluations);

  const category = categories.find((c) => c.id === report?.categoryId) ?? null;
  const scoreCriteria = getEffectiveCriteria(category, globalScoreCriteria);
  // category.specification (dosya metadata'sı) admin bir şartname
  // yüklediğinde category.specificationText (gerçek metin) ile birlikte
  // atomik olarak set edilir (bkz. PUT /api/categories/[id]/specification)
  // — bu yüzden frontend'e specificationText'in kendisini hiç göndermeden
  // güvenilir bir "şartname var mı" sinyali olarak kullanılabilir.
  const hasSpecification = Boolean(category?.specification);

  const [isLoading, setIsLoading] = useState(true);
  const [analysisState, setAnalysisState] = useState<AnalysisState>("idle");
  const [analysis, setAnalysis] = useState<AIAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const retryAnalysisWithForce = useRef(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [compactCompliance, setCompactCompliance] = useState(false);

  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [focusedEvidenceId, setFocusedEvidenceId] = useState<string | null>(null);
  const [focusedPassage, setFocusedPassage] = useState<{ page: number; excerpt: string } | null>(
    null,
  );

  const existingEvaluation = useMemo(
    () => evaluations.find((e) => e.reportId === reportId && e.judgeId === user?.id) ?? null,
    [evaluations, reportId, user],
  );

  const [scores, setScores] = useState<Record<string, number>>({});
  const pdfFile = useMemo(() => ({ url: report?.pdfUrl ?? "" }), [report?.pdfUrl]);
  const pdfOptions = useMemo(() => ({ verbosity: 0 }), []);
  const onPdfLoadSuccess = useCallback(({ numPages: count }: { numPages: number }) => {
    setNumPages(count);
    setPageNumber((current) => Math.min(Math.max(current, 1), count));
  }, []);
  const onPdfRenderError = useCallback((error: Error) => {
    if (error.name === "AbortException" || /TextLayer task cancelled/i.test(error.message)) return;
    console.error("PDF sayfası oluşturulamadı:", error);
  }, []);
  const [overallComment, setOverallComment] = useState("");
  const [saving, setSaving] = useState(false);

  const [findingDecisions, setFindingDecisions] = useState<Record<string, "flagged" | "dismissed">>(
    {},
  );
  const [disqualification, setDisqualification] = useState<DisqualificationRecommendation | null>(
    null,
  );
  const [pendingDecision, setPendingDecision] = useState<{
    finding: GateFinding;
    decision: "flagged" | "dismissed";
  } | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  const [messages, setMessages] = useState<CopilotChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        'Merhaba! Analiz tamamlandığında bu rapor hakkındaki sorularını yanıtlayabilirim. Örneğin "en kritik şartname problemi nedir?" diye sorabilirsin.',
      createdAt: new Date().toISOString(),
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([refreshReports(), refreshEvaluations(), refreshScoreCriteria()])
      .catch((error) => {
        console.error("Değerlendirme verileri yüklenemedi:", error);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reportId]);

  useEffect(() => {
    if (existingEvaluation) {
      const map: Record<string, number> = {};
      existingEvaluation.criteriaScores.forEach((cs) => {
        map[cs.criterionId] = cs.score;
      });
      setScores(map);
      setOverallComment(existingEvaluation.overallComment);
      if (existingEvaluation.disqualificationRecommendation) {
        setDisqualification(existingEvaluation.disqualificationRecommendation);
        setFindingDecisions((prev) => ({
          ...prev,
          [existingEvaluation.disqualificationRecommendation!.findingId]: "flagged",
        }));
      }
    }
  }, [existingEvaluation]);

  const maxTotalScore = useMemo(
    () => scoreCriteria.reduce((sum, c) => sum + c.maxScore, 0),
    [scoreCriteria],
  );

  const totalScore = useMemo(
    () => scoreCriteria.reduce((sum, c) => sum + (scores[c.id] ?? 0), 0),
    [scoreCriteria, scores],
  );

  /**
   * AI'ya ayrı bir totalScore ÜRETTİRİLMEZ — AI Ön Puanı, zaten üretilmiş
   * criteriaEvaluations'daki kriter puanlarından burada deterministik olarak
   * toplanır (bkz. computeAiPreliminaryScore). Bir kriterin puanı/ölçeği
   * eksikse toplam sessizce 0 kabul edilmez; `incomplete` ile işaretlenir.
   */
  const aiPreliminaryScore = useMemo(
    () =>
      analysis && analysis.relevanceAnalysis?.status !== "unrelated"
        ? computeAiPreliminaryScore(
            analysis.criteriaEvaluations.map((c) => ({ score: c.score, maxScore: c.maxScore })),
          )
        : null,
    [analysis],
  );

  const relevanceBlocked = analysis?.relevanceAnalysis?.status === "unrelated";
  const relevanceUncertain = analysis?.relevanceAnalysis?.status === "uncertain";

  const scoreDiff = computeOverallScoreDiff(
    aiPreliminaryScore,
    hasCompleteJudgeScore(scoreCriteria, scores),
    totalScore,
  );

  const gateFindings = useMemo(
    () => (analysis ? buildGateFindings(analysis) : []),
    [analysis],
  );

  const languageComplianceItem: ComplianceCheckItem | null = analysis
    ? {
        id: "language-check",
        label: "Rapor Dili",
        passed: analysis.languageCheck.passed,
        detail: `Tespit edilen dil: ${analysis.languageCheck.detectedLanguage} (beklenen: ${analysis.languageCheck.expectedLanguage}, güven: %${analysis.languageCheck.confidence})`,
        evidenceIds: [],
      }
    : null;

  const summaryCounts = useMemo(() => {
    if (!analysis) return null;
    return {
      critical: analysis.criticalFindings.length,
      highSimilarity: analysis.similarReports.filter((r) => r.matchPercentage >= 70).length,
      formatProblems: analysis.templateCompliance.filter((c) => !c.passed).length,
      improvements: analysis.contentAnalysis.improvementSuggestions.length,
      strengths: analysis.contentAnalysis.strengths.length,
    };
  }, [analysis]);

  /**
   * Sonuçlar zaten tek bir gerçek API çağrısıyla birlikte geldi (bkz.
   * handleStartAnalysis) — burada yapay bir gecikme/adım animasyonu yok,
   * yalnızca hazır sonucu göstermeye geçiliyoruz.
   */
  function revealResults() {
    setAnalysisState("done");
    setMessages((prev) => [
      ...prev,
      {
        id: "analysis-ready",
        role: "assistant",
        content:
          "Analiz tamamlandı. Şartname, şablon, içerik ve benzerlik sonuçlarını sağdaki panelde görebilirsin. Merak ettiğin bir şey varsa buradan sorabilirsin.",
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  /** Yeni gelen (taze çalıştırılmış ya da zaten güncel önbellekten) sonucu, gate bulgusu varsa karar beklemeye, yoksa doğrudan sonuçlara geçirir. */
  function applyAnalysisResult(result: AIAnalysisResult) {
    setAnalysis(result);

    if (buildGateFindings(result).length > 0) {
      setAnalysisState("awaiting-decision");
      return;
    }

    revealResults();
  }

  async function handleStartAnalysis(options?: { force?: boolean }) {
    const force = options?.force === true;
    retryAnalysisWithForce.current = force;
    setAnalysisState("checking");
    setAnalysisError(null);

    let result: AIAnalysisResult;
    try {
      result = await aiAnalysisService.getAIAnalysis(reportId, hasSpecification, { force });
    } catch (error) {
      setAnalysisState("error");
      setAnalysisError(error instanceof Error ? error.message : "AI analizi başlatılamadı.");
      return;
    }
    applyAnalysisResult(result);
  }

  useEffect(() => {
    if (analysisState !== "awaiting-decision" || !analysis) return;
    const allDecided = gateFindings.every((f) => findingDecisions[f.id]);
    if (!allDecided) return;

    const anyFlagged = gateFindings.some(
      (f) => f.allowsElimination && findingDecisions[f.id] === "flagged"
    );
    if (anyFlagged) {
      setAnalysisState("eliminated");
      toast.warning(
        "Elenme önerildiği için kalan analiz aşamaları (şablon, içerik, benzerlik, AI yazım riski) atlandı.",
      );
    } else {
      revealResults();
    }
  }, [analysisState, analysis, findingDecisions, gateFindings]);

  useEffect(() => {
    // Raporda zaten güncel (stale olmayan) bir aiEvaluation varsa, hakem
    // raporu her açışında Cloudflare AI'yı gereksiz yere tekrar çalıştırmak
    // yerine mevcut sonuç doğrudan gösterilir (bkz. toAIAnalysisResult —
    // aynı gerçek AI çıktısı → AIAnalysisResult dönüşümü, tek yerden).
    // Yönergeler değiştiyse (aiAnalysisStale) burada sessizce göstermek
    // yerine aşağıdaki stale-kontrol effect'i devreye girer.
    if (isLoading || analysisState !== "idle" || analysis) return;
    if (!report?.aiEvaluation || report.aiAnalysisStale) return;

    applyAnalysisResult(
      aiAnalysisService.toAIAnalysisResult(reportId, report.aiEvaluation, hasSpecification),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, analysisState, analysis, reportId, report?.aiEvaluation, report?.aiAnalysisStale, hasSpecification]);

  useEffect(() => {
    // Admin şartname/şablon/kriterleri bu raporun daha önceki AIAnalysis'i
    // ÜRETİLDİKTEN SONRA değiştirdiyse (bkz. GET /api/reports'un
    // aiAnalysisStale hesaplaması), eski sonucu sessizce göstermeye/yeniden
    // hesaplamaya devam ETMEYİZ — hakemi açıkça uyarırız, yeniden çalıştırma
    // kararı ona ait.
    if (isLoading || !report?.aiAnalysisStale) return;
    if (analysisState !== "idle") return;
    setAnalysisState("stale");
  }, [isLoading, report, analysisState]);

  function jumpToEvidence(evidenceId: string) {
    const evidence = analysis?.evidences.find((e) => e.id === evidenceId);
    if (!evidence) return;
    setPageNumber(evidence.page);
    setFocusedEvidenceId(evidenceId);
    setFocusedPassage(null);
  }

  /** Benzerlik panelindeki bir eşleşmeye tıklandığında — evidence id'siz, doğrudan gerçek sayfa+alıntıyla. */
  function jumpToPassage(page: number, excerpt: string) {
    setPageNumber(page);
    setFocusedPassage({ page, excerpt });
    setFocusedEvidenceId(null);
  }

  const highlightQuery = useMemo(() => {
    if (focusedPassage) return buildHighlightQuery(focusedPassage.excerpt);
    if (!focusedEvidenceId || !analysis) return null;
    const evidence = analysis.evidences.find((e) => e.id === focusedEvidenceId);
    return evidence ? buildHighlightQuery(evidence.excerpt) : null;
  }, [focusedEvidenceId, focusedPassage, analysis]);

  const customTextRenderer = useCallback(
    ({ str }: { str: string }) => highlightTextItem(str, highlightQuery),
    [highlightQuery]
  );

  function requestFindingDecision(finding: GateFinding, decision: "flagged" | "dismissed") {
    setPendingDecision({ finding, decision });
  }

  function confirmPendingDecision() {
    if (!pendingDecision) return;
    const { finding, decision } = pendingDecision;

    setFindingDecisions((prev) => ({ ...prev, [finding.id]: decision }));
    if (decision === "flagged") {
      setDisqualification({
        findingId: finding.id,
        ruleText: finding.ruleText,
        findingText: finding.findingText,
        evidenceId: finding.evidenceId,
        decidedAt: new Date().toISOString(),
      });
      toast.warning("Eleme önerisi kaydedildi. Nihai karar değerlendirmeyi kaydettiğinde işlenecek.");
    } else {
      toast.info("İncelemeye devam ediliyor.");
    }
    setPendingDecision(null);
  }

  function handleScoreChange(criterionId: string, maxScore: number, raw: string) {
    const value = Math.max(0, Math.min(maxScore, Number(raw) || 0));
    setScores((prev) => ({ ...prev, [criterionId]: value }));
  }

  const hasUnsavedProgress =
    existingEvaluation?.status !== "submitted" &&
    (overallComment.trim() !== (existingEvaluation?.overallComment ?? "").trim() ||
      scoreCriteria.some((criterion) => {
        const savedScore =
          existingEvaluation?.criteriaScores.find((cs) => cs.criterionId === criterion.id)?.score ?? 0;
        return (scores[criterion.id] ?? 0) !== savedScore;
      }) ||
      JSON.stringify(disqualification) !==
        JSON.stringify(existingEvaluation?.disqualificationRecommendation ?? null) ||
      Object.values(findingDecisions).some((decision) => decision === "dismissed"));

  function handleBackToPanel() {
    if (hasUnsavedProgress) {
      setLeaveConfirmOpen(true);
      return;
    }
    router.push("/judge");
  }

  async function persistEvaluation(
    status: "draft" | "submitted",
    options?: { navigateAfter?: boolean },
  ) {
    if (!user || !report) return;
    setSaving(true);

    const evaluation = {
      id: existingEvaluation?.id ?? `eval-${report.id}-${user.id}`,
      reportId: report.id,
      judgeId: user.id,
      criteriaScores: scoreCriteria.map((c) => ({
        criterionId: c.id,
        score: scores[c.id] ?? 0,
      })),
      totalScore,
      overallComment,
      status,
      disqualificationRecommendation: disqualification,
      updatedAt: new Date().toISOString(),
    };

    try {
      await evaluationsService.saveEvaluation(evaluation);
      // Değerlendirme durumu değişince rapor durumu da (in_review/completed/
      // disqualified) sunucuda otomatik türetiliyor — ikisini de tazelemek gerekir.
      await Promise.all([refreshEvaluations(), refreshReports()]);
      toast.success(status === "draft" ? "Taslak kaydedildi." : "Değerlendirme tamamlandı.");
      if (status === "submitted" || options?.navigateAfter) {
        router.push("/judge");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Değerlendirme kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDraftAndLeave() {
    setLeaveConfirmOpen(false);
    await persistEvaluation("draft", { navigateAfter: true });
  }

  function handleDiscardAndLeave() {
    setLeaveConfirmOpen(false);
    router.push("/judge");
  }

  async function handleSendChat(e: FormEvent) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;

    setMessages((prev) => [
      ...prev,
      {
        id: `msg-${crypto.randomUUID()}`,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      },
    ]);
    setChatInput("");
    setChatSending(true);

    let reply: string;
    try {
      reply = await copilotService.askCopilot(reportId, text);
    } catch (error) {
      reply = error instanceof Error ? error.message : "Ludex Copilot şu anda yanıt veremiyor.";
    }
    setChatSending(false);
    setMessages((prev) => [
      ...prev,
      {
        id: `msg-${crypto.randomUUID()}`,
        role: "assistant",
        content: reply,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  if (isLoading) {
    return (
      <>
        <AppHeader subtitle="Değerlendirme" />
        <div className="min-h-[calc(100vh-4rem)]">
          <main className="w-full px-6 py-8 md:px-12">
            <Skeleton className="h-8 w-72" />
            <div className="mt-6 grid gap-6 lg:grid-cols-[7fr_3fr]">
              <Skeleton className="h-[600px] w-full" />
              <Skeleton className="h-[600px] w-full" />
            </div>
          </main>
        </div>
      </>
    );
  }

  if (!report) {
    return (
      <>
        <AppHeader subtitle="Değerlendirme" />
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
          <main className="mx-auto max-w-md px-6 py-8 text-center">
            <h1 className="text-xl font-semibold tracking-tight">Rapor bulunamadı</h1>
            <p className="mt-2 text-base text-muted-foreground">
              Bu rapor artık mevcut değil ya da sana atanmamış olabilir.
            </p>
            <Button className="mt-6" onClick={() => router.push("/judge")}>
              Hakem paneline dön
            </Button>
          </main>
        </div>
      </>
    );
  }

  return (
    <>
      <AppHeader subtitle="Değerlendirme" />
      <div className="min-h-[calc(100vh-4rem)]">
        <main className="w-full px-6 py-6 md:px-12">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{report.title}</h1>
              <p className="mt-1 text-base text-muted-foreground">
                {report.contestantName} &middot; {category?.name ?? "Kategori"}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={handleBackToPanel}>
              ← Panele Dön
            </Button>
          </div>

          <div className="grid gap-6 lg:grid-cols-[7fr_3fr]">
            {/* SOL: PDF (%70) */}
            <Card className="flex h-[calc(100vh-100px)] flex-col overflow-hidden py-0">
              <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
                <span className="text-base font-medium">Yarışmacının Raporu (PDF)</span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={pageNumber <= 1}
                    onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="text-base whitespace-nowrap text-muted-foreground">
                    {pageNumber} / {numPages || "–"}
                  </span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={pageNumber >= numPages}
                    onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="flex-1 overflow-auto bg-muted/40 p-4">
                <Document
                  file={pdfFile}
                  options={pdfOptions}
                  onLoadSuccess={onPdfLoadSuccess}
                  loading={<Skeleton className="mx-auto h-[500px] w-full max-w-sm" />}
                  error={
                    <p className="p-6 text-center text-base text-muted-foreground">
                      PDF yüklenemedi.
                    </p>
                  }
                  className="mx-auto flex justify-center"
                >
                  <Page
                    pageNumber={pageNumber}
                    width={420}
                    renderAnnotationLayer={false}
                    onRenderError={onPdfRenderError}
                    onRenderTextLayerError={onPdfRenderError}
                    customTextRenderer={customTextRenderer}
                  />
                </Document>
              </div>
            </Card>

            {/* SAĞ: Ludex analizleri + hakem değerlendirmesi (%30) */}
            <div className="h-[calc(100vh-100px)] overflow-y-auto pr-1">
              <div className="space-y-6">
                {analysisState === "idle" && (
                  <Card>
                    <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                      <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-lg shadow-primary/25">
                        <Sparkles className="size-7" />
                      </div>
                      <div>
                        <p className="text-base font-semibold">Ludex analizi henüz başlatılmadı</p>
                        <p className="mt-1 max-w-xs text-base text-muted-foreground">
                          Şartname, şablon, içerik ve benzerlik analizini başlatmak için aşağıdaki
                          butona bas.
                        </p>
                      </div>
                      <Button
                        onClick={() => handleStartAnalysis()}
                        className="mt-2 gap-2 transition-transform active:scale-[0.98]"
                      >
                        <Sparkles className="size-4" />
                        Ludex Analizine Başla
                      </Button>
                    </CardContent>
                  </Card>
                )}

                {analysisState === "error" && (
                  <Card className="border-red-300 dark:border-red-900">
                    <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                      <div className="flex size-14 items-center justify-center rounded-2xl bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400">
                        <AlertOctagon className="size-7" />
                      </div>
                      <div>
                        <p className="text-base font-semibold">Ludex analizi başlatılamadı</p>
                        <p className="mt-1 max-w-xs text-base text-muted-foreground">
                          {analysisError ?? "Analiz sırasında bir hata oluştu."}
                        </p>
                      </div>
                      <Button
                        onClick={() => handleStartAnalysis({ force: retryAnalysisWithForce.current })}
                        variant="outline"
                        className="mt-2 gap-2 transition-transform active:scale-[0.98]"
                      >
                        <Sparkles className="size-4" />
                        Tekrar Dene
                      </Button>
                    </CardContent>
                  </Card>
                )}

                {analysisState === "stale" && (
                  <Card className="border-amber-300 dark:border-amber-900">
                    <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                      <div className="flex size-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                        <AlertTriangle className="size-7" />
                      </div>
                      <div>
                        <p className="text-base font-semibold">Yarışma yönergeleri değişti</p>
                        <p className="mt-1 max-w-xs text-base text-muted-foreground">
                          Ludex analizini yeniden çalıştır.
                        </p>
                      </div>
                      <Button
                        onClick={() => handleStartAnalysis({ force: true })}
                        className="mt-2 gap-2 transition-transform active:scale-[0.98]"
                      >
                        <Sparkles className="size-4" />
                        Yeniden Çalıştır
                      </Button>
                    </CardContent>
                  </Card>
                )}

                {analysisState === "checking" && (
                  <Card>
                    <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
                      <Loader2 className="size-8 animate-spin text-primary" />
                      <p className="text-base font-medium text-foreground">
                        Ludex semantik analizi çalışıyor...
                      </p>
                      <div className="space-y-1">
                        {ANALYSIS_CHECK_LABELS.map((label) => (
                          <p key={label} className="text-base text-muted-foreground/60">
                            {label}
                          </p>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {analysis && gateFindings.length > 0 && (
                  <div className="animate-in fade-in-0 slide-in-from-bottom-2 space-y-4 duration-500">
                    {languageComplianceItem && (
                      <Card>
                        <CardContent className="pt-6">
                          <ComplianceRow
                            item={languageComplianceItem}
                            analysis={analysis}
                            onEvidence={jumpToEvidence}
                          />
                        </CardContent>
                      </Card>
                    )}

                    {analysisState === "awaiting-decision" && (
                      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-base text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                        {hasSpecification
                          ? "Şartname ve dil denetimi tamamlandı. Kalan analiz aşamalarına geçmeden önce aşağıdaki bulgu(lar) için karar ver."
                          : "Dil denetimi tamamlandı. Bu kategori için şartname yüklenmediğinden şartname kontrolü atlandı. Kalan analiz aşamalarına geçmeden önce aşağıdaki bulgu(lar) için karar ver."}
                      </p>
                    )}

                    {analysisState === "eliminated" && (
                      <Alert variant="destructive" className="border-red-300 dark:border-red-900">
                        <AlertOctagon className="size-4" />
                        <AlertTitle>Analiz durduruldu</AlertTitle>
                        <AlertDescription>
                          Elenme önerildiği için şablon, içerik, benzerlik ve AI yazım riski
                          aşamaları çalıştırılmadı.
                        </AlertDescription>
                      </Alert>
                    )}

                    {gateFindings.map((finding) => {
                      const decision = findingDecisions[finding.id];
                      const evidenceId = finding.evidenceId;
                      return (
                        <Card
                          key={finding.id}
                          className={
                            finding.allowsElimination
                              ? "border-red-300 dark:border-red-900"
                              : "border-amber-300 dark:border-amber-900"
                          }
                        >
                          <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-base text-red-700 dark:text-red-400">
                              <AlertOctagon className="size-4" />
                              {finding.title}
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <div>
                              <p className="text-base font-medium text-muted-foreground">Şartname kuralı</p>
                              <p className="text-base">{finding.ruleText}</p>
                              {finding.sourceLabel && (
                                <p className="mt-1 text-sm text-muted-foreground">Kaynak: {finding.sourceLabel}</p>
                              )}
                            </div>
                            <div>
                              <p className="text-base font-medium text-muted-foreground">Rapor bulgusu</p>
                              <p className="text-base">{finding.findingText}</p>
                            </div>
                            {evidenceId && (
                              <Button
                                type="button"
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-base"
                                onClick={() => jumpToEvidence(evidenceId)}
                              >
                                Kanıt: Rapor, Sayfa {analysis.evidences.find((e) => e.id === evidenceId)?.page}
                              </Button>
                            )}
                            <div className="grid min-w-0 grid-cols-1 gap-2 rounded-lg bg-muted/50 px-3 py-2 text-base sm:flex sm:items-center sm:justify-between">
                              <span className="min-w-0 text-muted-foreground">AI değerlendirmesi</span>
                              <Badge variant="outline" className={`max-w-full justify-self-start whitespace-normal break-words ${SEVERITY_CLASS[finding.probability]}`}>
                                {finding.allowsElimination
                                  ? `Açık eleme kuralı: ${SEVERITY_LABEL[finding.probability]}`
                                  : `Hakem incelemesi gerekli: ${SEVERITY_LABEL[finding.probability]}`}
                              </Badge>
                            </div>

                            {decision ? (
                              <p className="text-base font-medium text-muted-foreground">
                                {decision === "flagged" && finding.allowsElimination
                                  ? "Elemeyi önerdin — bu karar değerlendirme kaydına eklenecek."
                                  : "Hakem incelemesine devam etmeyi seçtin."}
                              </p>
                            ) : (
                              <div className="flex gap-2">
                                {finding.allowsElimination && (
                                  <Button
                                    type="button"
                                    variant="destructive"
                                    size="sm"
                                    className="flex-1 gap-1.5"
                                    onClick={() => requestFindingDecision(finding, "flagged")}
                                  >
                                    <ThumbsDown className="size-4" />
                                    ELEMEYİ ÖNER
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="flex-1 gap-1.5"
                                  onClick={() => requestFindingDecision(finding, "dismissed")}
                                >
                                  <ThumbsUp className="size-4" />
                                  {finding.allowsElimination ? "İNCELEMEYE DEVAM ET" : "HAKEM İNCELEMESİNE AKTAR"}
                                </Button>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                )}

                {analysis && (relevanceBlocked || relevanceUncertain) && (
                  <Alert variant={relevanceBlocked ? "destructive" : "default"}>
                    <ShieldAlert className="size-4" />
                    <AlertTitle>
                      {relevanceBlocked ? "Kategori/Problem Uyumsuzluğu" : "Kategori/Problem Eşleşmesi Belirsiz"}
                    </AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>
                        {relevanceBlocked
                          ? "Raporun temel konusu, aktif yarışma problemiyle anlamlı biçimde eşleşmiyor. Normal puanlama durduruldu."
                          : "AI kriter değerlendirmesi tamamlandı; kategori/problem eşleşmesi için ayrıca hakem incelemesi gerekiyor."}
                      </p>
                      <p>{analysis.relevanceAnalysis?.explanation}</p>
                      {analysis.relevanceAnalysis?.reportExcerpt && (
                        <p className="text-sm">Rapor kanıtı: {analysis.relevanceAnalysis.reportExcerpt}</p>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {analysisState === "done" && analysis && summaryCounts && (
                  <div className="animate-in fade-in-0 slide-in-from-bottom-2 space-y-6 duration-500">
                    <Card className="border-primary/30 bg-primary/5">
                      <CardHeader>
                        <CardTitle className="text-base">Ludex Özeti</CardTitle>
                        <CardDescription>Bu raporda özellikle dikkat etmen gerekenler.</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-wrap gap-2">
                        <Badge variant="outline" className={SEVERITY_CLASS.high}>
                          {summaryCounts.critical} Kritik Şartname Bulgusu
                        </Badge>
                        <Badge variant="outline" className={SEVERITY_CLASS.medium}>
                          {summaryCounts.highSimilarity} Yüksek Benzerlik
                        </Badge>
                        <Badge variant="outline" className={SEVERITY_CLASS.low}>
                          {summaryCounts.formatProblems} Format Problemi
                        </Badge>
                        <Badge variant="secondary">{summaryCounts.improvements} Geliştirilebilir Alan</Badge>
                        <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                          {summaryCounts.strengths} Güçlü Alan
                        </Badge>
                      </CardContent>
                    </Card>

                    <div className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant={compactCompliance ? "ghost" : "secondary"}
                        size="icon-sm"
                        aria-label="Kutu görünümü"
                        onClick={() => setCompactCompliance(false)}
                      >
                        <LayoutGrid className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant={compactCompliance ? "secondary" : "ghost"}
                        size="icon-sm"
                        aria-label="Liste görünümü"
                        onClick={() => setCompactCompliance(true)}
                      >
                        <List className="size-4" />
                      </Button>
                    </div>

                    <Card className="overflow-hidden py-0">
                      <ScrollArea className="h-[420px] px-4 py-4">
                        <Accordion
                          type="multiple"
                          defaultValue={["language", "spec"]}
                          className="space-y-2"
                        >
                          <AccordionItem value="language" className="rounded-lg border border-border px-3">
                            <AccordionTrigger className="text-base font-medium hover:no-underline">
                              Aşama 1 – Dil Tespiti
                            </AccordionTrigger>
                            <AccordionContent className="space-y-2">
                              {languageComplianceItem && (
                                <ComplianceRow
                                  item={languageComplianceItem}
                                  analysis={analysis}
                                  onEvidence={jumpToEvidence}
                                  compact={compactCompliance}
                                />
                              )}
                            </AccordionContent>
                          </AccordionItem>

                          <AccordionItem value="spec" className="rounded-lg border border-border px-3">
                            <AccordionTrigger className="text-base font-medium hover:no-underline">
                              Aşama 2 – Şartname Denetimi
                            </AccordionTrigger>
                            <AccordionContent className="space-y-2">
                              {hasSpecification ? (
                                analysis.specCompliance.map((item) => (
                                  <ComplianceRow
                                    key={item.id}
                                    item={item}
                                    analysis={analysis}
                                    onEvidence={jumpToEvidence}
                                  compact={compactCompliance}
                                  />
                                ))
                              ) : (
                                <p className="text-base text-muted-foreground">
                                  Bu kategori için şartname yüklenmediğinden şartname uygunluğu
                                  kontrolü yapılmadı.
                                </p>
                              )}
                            </AccordionContent>
                          </AccordionItem>

                          <AccordionItem value="template" className="rounded-lg border border-border px-3">
                            <AccordionTrigger className="text-base font-medium hover:no-underline">
                              Aşama 3 – Şablon Denetimi
                            </AccordionTrigger>
                            <AccordionContent className="space-y-2">
                              {analysis.templateCompliance.map((item) => (
                                <ComplianceRow
                                  key={item.id}
                                  item={item}
                                  analysis={analysis}
                                  onEvidence={jumpToEvidence}
                                compact={compactCompliance}
                                />
                              ))}
                            </AccordionContent>
                          </AccordionItem>

                          <AccordionItem value="content" className="rounded-lg border border-border px-3">
                            <AccordionTrigger className="text-base font-medium hover:no-underline">
                              Aşama 4 – Proje ve İçerik Analizi
                            </AccordionTrigger>
                            <AccordionContent className="space-y-3">
                              <p className="text-base text-muted-foreground">
                                {analysis.contentAnalysis.summary}
                              </p>
                              <div>
                                <p className="mb-1 text-base font-semibold text-emerald-700 dark:text-emerald-400">
                                  Güçlü Yönler
                                </p>
                                <ul className="list-inside list-disc space-y-0.5 text-base text-muted-foreground">
                                  {analysis.contentAnalysis.strengths.map((s) => (
                                    <li key={s}>{s}</li>
                                  ))}
                                </ul>
                              </div>
                              <div>
                                <p className="mb-1 text-base font-semibold text-red-700 dark:text-red-400">
                                  Zayıf Yönler
                                </p>
                                <ul className="list-inside list-disc space-y-0.5 text-base text-muted-foreground">
                                  {analysis.contentAnalysis.weaknesses.map((s) => (
                                    <li key={s}>{s}</li>
                                  ))}
                                </ul>
                              </div>
                              <div>
                                <p className="mb-1 text-base font-semibold text-primary">
                                  Geliştirme Önerileri
                                </p>
                                <ul className="list-inside list-disc space-y-0.5 text-base text-muted-foreground">
                                  {analysis.contentAnalysis.improvementSuggestions.map((s) => (
                                    <li key={s}>{s}</li>
                                  ))}
                                </ul>
                              </div>
                            </AccordionContent>
                          </AccordionItem>

                          <AccordionItem value="similarity" className="rounded-lg border border-border px-3">
                            <AccordionTrigger className="text-base font-medium hover:no-underline">
                              Aşama 5 – Kategori Uygunluğu ve Benzerlik
                              {analysis.similarityScore != null ? ` (%${analysis.similarityScore})` : ""}
                            </AccordionTrigger>
                            <AccordionContent className="space-y-3">
                              <ComplianceRow
                                item={{
                                  id: "category-fit-check",
                                  label: "Kategori Uygunluğu",
                                  passed: analysis.categoryFitCheck.passed,
                                  detail:
                                    analysis.categoryFitCheck.matchScore != null
                                      ? `${analysis.categoryFitCheck.explanation} (uyum skoru: %${analysis.categoryFitCheck.matchScore})`
                                      : analysis.categoryFitCheck.explanation,
                                  evidenceIds: [],
                                }}
                                analysis={analysis}
                                onEvidence={jumpToEvidence}
                              compact={compactCompliance}
                              />
                              {analysis.similarReports.map((match) => (
                                <div key={match.id} className="space-y-2 rounded-lg bg-muted/40 p-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-base font-medium">{match.reportLabel}</p>
                                    <span className="text-base font-semibold text-primary">
                                      %{match.matchPercentage}
                                    </span>
                                  </div>
                                  {match.breakdown.length > 0 && (
                                    <div className="space-y-2">
                                      {match.breakdown.map((b, i) => (
                                        <div key={`${match.id}-${i}`} className="space-y-1 border-t border-border/60 pt-2 text-base">
                                          <div>
                                            <p className="text-sm text-muted-foreground">
                                              Bu rapor — Sayfa {b.targetPage}
                                            </p>
                                            <Button
                                              type="button"
                                              variant="link"
                                              size="sm"
                                              className="h-auto p-0 text-left text-base italic"
                                              onClick={() => jumpToPassage(b.targetPage, b.targetExcerpt)}
                                            >
                                              &ldquo;{b.targetExcerpt}&rdquo;
                                            </Button>
                                          </div>
                                          <div>
                                            <p className="text-sm text-muted-foreground">
                                              Diğer rapor — Sayfa {b.matchedPage}
                                            </p>
                                            <p className="italic text-muted-foreground">
                                              &ldquo;{b.matchedExcerpt}&rdquo;
                                            </p>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </AccordionContent>
                          </AccordionItem>

                          <AccordionItem value="criteria" className="rounded-lg border border-border px-3">
                            <AccordionTrigger className="text-base font-medium hover:no-underline">
                              Aşama 7 – Kriter Bazlı AI Değerlendirmesi
                            </AccordionTrigger>
                            <AccordionContent className="space-y-2">
                              {analysis.relevanceAnalysis?.status === "unrelated" ? (
                                <p className="rounded-lg bg-muted/40 p-3 text-base text-muted-foreground">
                                  Puanlama yapılmadı; kategori/problem eşleşmesi için hakem incelemesi gerekiyor.
                                </p>
                              ) : (
                                analysis.criteriaEvaluations.map((c) => (
                                  <CriterionEvaluationRow
                                    key={c.id}
                                    item={c}
                                    analysis={analysis}
                                    onEvidence={jumpToEvidence}
                                    judgeScore={scores[c.id]}
                                  />
                                ))
                              )}
                            </AccordionContent>
                          </AccordionItem>

                          {analysis.aiWritingRisk && (
                            <AccordionItem value="writing-risk" className="rounded-lg border border-border px-3">
                              <AccordionTrigger className="text-base font-medium hover:no-underline">
                                Aşama 6 – AI Yazım Riski ({SEVERITY_LABEL[analysis.aiWritingRisk.verdict]})
                              </AccordionTrigger>
                              <AccordionContent className="space-y-2">
                                <Badge variant="outline" className={SEVERITY_CLASS[analysis.aiWritingRisk.verdict]}>
                                  AI kullanımına işaret eden sinyaller: {SEVERITY_LABEL[analysis.aiWritingRisk.verdict]}
                                </Badge>
                                <p className="text-base text-muted-foreground">
                                  {analysis.aiWritingRisk.explanation}
                                </p>
                                {analysis.aiWritingRisk.flaggedSections.length > 0 && (
                                  <ul className="list-inside list-disc space-y-0.5 text-base text-muted-foreground">
                                    {analysis.aiWritingRisk.flaggedSections.map((f) => (
                                      <li key={`${f.page}-${f.note}`}>
                                        Sayfa {f.page} – {f.note}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                <p className="text-base italic text-muted-foreground">
                                  Bu kesin bir AI tespiti değildir; yalnızca ek inceleme için bir işarettir.
                                </p>
                              </AccordionContent>
                            </AccordionItem>
                          )}
                        </Accordion>

                        {focusedEvidenceId && (
                          <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
                            <p className="text-base font-medium text-primary">
                              Kanıt (Sayfa {analysis.evidences.find((e) => e.id === focusedEvidenceId)?.page})
                            </p>
                            <p className="mt-1 text-base text-muted-foreground italic">
                              &ldquo;{analysis.evidences.find((e) => e.id === focusedEvidenceId)?.excerpt}
                              &rdquo;
                            </p>
                          </div>
                        )}
                        {focusedPassage && (
                          <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
                            <p className="text-base font-medium text-primary">
                              Benzer Pasaj (Sayfa {focusedPassage.page})
                            </p>
                            <p className="mt-1 text-base text-muted-foreground italic">
                              &ldquo;{focusedPassage.excerpt}&rdquo;
                            </p>
                          </div>
                        )}
                      </ScrollArea>
                    </Card>

                    {analysis.redFlags.length > 0 && (
                      <div className="space-y-3">
                        <p className="flex items-center gap-2 text-base font-semibold text-red-600 dark:text-red-400">
                          <Flag className="size-4" />
                          Kırmızı Bayraklar ({analysis.redFlags.length})
                        </p>
                        {analysis.redFlags.map((flag) => (
                          <Alert
                            key={flag.id}
                            variant="destructive"
                            className="border-red-300 dark:border-red-900"
                          >
                            <AlertOctagon className="size-4" />
                            <AlertTitle className="flex items-center justify-between gap-2">
                              <span>{flag.title}</span>
                              <Badge variant="outline" className={SEVERITY_CLASS[flag.severity]}>
                                {SEVERITY_LABEL[flag.severity]}
                              </Badge>
                            </AlertTitle>
                            <AlertDescription className="space-y-1.5">
                              <p>{flag.description}</p>
                              {flag.evidenceIds.map((eid) => (
                                <Button
                                  key={eid}
                                  type="button"
                                  variant="link"
                                  size="sm"
                                  className="h-auto p-0 text-base"
                                  onClick={() => jumpToEvidence(eid)}
                                >
                                  Neden? (Sayfa {analysis.evidences.find((e) => e.id === eid)?.page})
                                </Button>
                              ))}
                            </AlertDescription>
                          </Alert>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Hakemin Kendi Değerlendirmesi</CardTitle>
                    <CardDescription>Ludex karar vermez; nihai puan ve karar sana ait.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {scoreCriteria.map((criterion) => (
                      <div key={criterion.id} className="space-y-1.5">
                        <div className="flex items-center justify-between text-base">
                          <Label htmlFor={`score-${criterion.id}`}>{criterion.label}</Label>
                          <span className="text-base text-muted-foreground">/ {criterion.maxScore}</span>
                        </div>
                        <Input
                          id={`score-${criterion.id}`}
                          type="number"
                          min={0}
                          max={criterion.maxScore}
                          value={scores[criterion.id] ?? 0}
                          onChange={(e) =>
                            handleScoreChange(criterion.id, criterion.maxScore, e.target.value)
                          }
                        />
                      </div>
                    ))}

                    <Separator />

                    <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
                      <span className="text-base font-medium">Toplam</span>
                      <span className="text-lg font-bold text-primary">
                        {totalScore} / {maxTotalScore}
                      </span>
                    </div>

                    {aiPreliminaryScore && (
                      <div className="rounded-lg border border-border px-3 py-2 text-base">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Sparkles className="size-3.5" />
                            AI Ön Puanı
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-lg font-bold text-primary">
                              {aiPreliminaryScore.incomplete
                                ? "Eksik"
                                : `${aiPreliminaryScore.score} / ${aiPreliminaryScore.maxScore}`}
                            </span>
                            {scoreDiff !== null && (
                              <span
                                className={
                                  scoreDiff === 0
                                    ? "text-muted-foreground"
                                    : scoreDiff > 0
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-red-600 dark:text-red-400"
                                }
                              >
                                {scoreDiff > 0 ? "+" : ""}
                                {scoreDiff} fark
                              </span>
                            )}
                          </div>
                        </div>
                        {aiPreliminaryScore.incomplete && (
                          <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                            {aiPreliminaryScore.missingCount} kriter için puan ölçeği tanımlı değil.
                          </p>
                        )}
                        <p className="mt-1 text-sm italic text-muted-foreground">
                          Bu puan karar desteği amaçlıdır. Nihai değerlendirme hakeme aittir.
                        </p>
                      </div>
                    )}

                    {scoreDiff !== null && Math.abs(scoreDiff) >= 15 && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-base text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                        AI puan önerisi ile kendi değerlendirmen arasında anlamlı fark var.
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="overall-comment">Genel Yorum</Label>
                      <Textarea
                        id="overall-comment"
                        rows={3}
                        value={overallComment}
                        onChange={(e) => setOverallComment(e.target.value)}
                        placeholder="Genel değerlendirmen..."
                      />
                    </div>

                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="flex-1 gap-1.5"
                        disabled={saving}
                        onClick={() => persistEvaluation("draft")}
                      >
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        Taslak Kaydet
                      </Button>
                      <Button
                        type="button"
                        className="flex-1 gap-1.5"
                        disabled={saving}
                        onClick={() => persistEvaluation("submitted")}
                      >
                        {saving ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="size-4" />
                        )}
                        Tamamla
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </main>
      </div>

      <Button
        type="button"
        size="icon"
        onClick={() => setCopilotOpen(true)}
        className="fixed right-6 bottom-6 z-40 size-14 rounded-full shadow-[0_8px_30px_rgb(0,0,0,0.2)] transition-all active:scale-[0.95]"
      >
        <Bot className="size-6" />
        <span className="sr-only">Ludex Copilot&apos;u aç</span>
      </Button>

      <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
        <SheetContent side="right" className="flex flex-col p-0">
          <SheetHeader className="border-b border-border/60">
            <SheetTitle className="flex items-center gap-2">
              <Bot className="size-4 text-primary" />
              Ludex Copilot
            </SheetTitle>
            <SheetDescription>Rapor hakkında merak ettiğini sor.</SheetDescription>
          </SheetHeader>
          <ScrollArea className="flex-1 px-4">
            <div className="space-y-3 py-2">
              {messages.map((m) => (
                <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}>
                  <span
                    className={`inline-block max-w-[85%] rounded-xl px-3 py-2 text-base ${
                      m.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground"
                    }`}
                  >
                    {m.content}
                  </span>
                </div>
              ))}
              {chatSending && (
                <div className="text-left">
                  <span className="inline-flex items-center gap-1.5 rounded-xl bg-muted px-3 py-2 text-base text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    Yazıyor...
                  </span>
                </div>
              )}
            </div>
          </ScrollArea>
          <form
            onSubmit={handleSendChat}
            className="flex items-center gap-2 border-t border-border/60 p-4"
          >
            <Input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Bir soru sor..."
              className="h-9"
            />
            <Button
              type="submit"
              size="icon"
              className="rounded-full"
              disabled={chatSending || !chatInput.trim()}
            >
              <Send className="size-4" />
            </Button>
          </form>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={pendingDecision !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDecision(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDecision?.decision === "flagged"
                ? "Elemeyi önermek istediğine emin misin?"
                : "İncelemeye devam etmek istediğine emin misin?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDecision?.decision === "flagged"
                ? "Bu karar değerlendirme kaydına eklenecek ve kalan analiz aşamaları (şablon, içerik, benzerlik, AI yazım riski) çalıştırılmayacak."
                : "Bu bulguyu göz ardı edip Ludex analizinin kalan aşamalarına devam edilecek."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingDecision(null)}>Vazgeç</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingDecision?.decision === "flagged" ? "destructive" : "default"}
              onClick={confirmPendingDecision}
            >
              Onayla
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
        <AlertDialogContent className="p-6">
          <AlertDialogHeader>
            <AlertDialogTitle>Panele dönmek istediğine emin misin?</AlertDialogTitle>
            <AlertDialogDescription>
              Kaydedilmemiş değerlendirme değişikliklerin var. Taslak kayıt puanları, genel
              yorumu ve varsa eleme önerisini saklar; geçici inceleme seçimleri kaydedilmeden
              çıkılır.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mx-0 mb-0 flex-col flex-wrap gap-2 rounded-none border-t-0 bg-transparent p-0 sm:flex-col sm:justify-start">
            <AlertDialogAction
              disabled={saving}
              onClick={handleSaveDraftAndLeave}
              className="w-full"
            >
              Taslak Olarak Kaydet ve Çık
            </AlertDialogAction>
            <AlertDialogCancel
              disabled={saving}
              onClick={() => setLeaveConfirmOpen(false)}
              className="w-full"
            >
              Değerlendirmeye Devam Et
            </AlertDialogCancel>
            <AlertDialogAction
              variant="link"
              size="sm"
              disabled={saving}
              onClick={handleDiscardAndLeave}
              className="mx-auto mt-1 h-auto text-destructive/80 no-underline hover:text-destructive hover:underline"
            >
              Kaydetmeden Çık
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
