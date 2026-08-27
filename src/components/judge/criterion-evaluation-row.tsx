import React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CriterionAiEvaluation, Evidence } from "@/types";

/**
 * Kriter bazlı AI değerlendirmesi satırı — AI'nın puan ÖNERİSİni (nihai puan
 * değil) ve gerekçesini açıkça gösterir. Sayfa kanıtı opsiyoneldir; yokluğu
 * geçerli puanı gizlemez. Hakem puanı varsa aradaki fark ayrıca gösterilir.
 */
export function CriterionEvaluationRow({
  item,
  evidences,
  onEvidence,
  judgeScore,
}: {
  item: CriterionAiEvaluation;
  evidences: Evidence[];
  onEvidence: (id: string) => void;
  judgeScore?: number;
}) {
  const diff = judgeScore != null && item.score != null ? judgeScore - item.score : null;
  const unavailableLabel =
    item.scoreUnavailableReason === "relevance_blocked"
      ? "Puanlama yapılmadı"
      : item.scoreUnavailableReason === "evidence_unverified"
        ? "Kriter kanıtı doğrulanamadı"
        : item.scoreUnavailableReason === "scale_missing"
          ? "Puan ölçeği tanımlı değil"
          : "Puanlama yapılamadı";
  const evidenceUnavailable = item.score != null && item.evidenceIds.length === 0;

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
      {item.evidenceIds.map((evidenceId) => (
        <Button
          key={evidenceId}
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-base"
          onClick={() => onEvidence(evidenceId)}
        >
          Neden? (Sayfa {evidences.find((evidence) => evidence.id === evidenceId)?.page})
        </Button>
      ))}
      {evidenceUnavailable && (
        <p className="flex items-center gap-1 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          Sayfa kanıtı doğrulanamadı
        </p>
      )}
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
