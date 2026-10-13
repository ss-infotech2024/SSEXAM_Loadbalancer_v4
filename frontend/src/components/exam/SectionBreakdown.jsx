// components/exam/SectionBreakdown.jsx
// Per-section score summary. Renders nothing for old attempts without sections.
//   breakdown: [{ section, score, totalMarks, correctCount, wrongCount, skippedCount, percentage }]
//   compact:   inline chips (tables) instead of progress bars (result screens)
import React from "react";
import { cn } from "../../utils/cn";

const barTone = (pct) => (pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-rose-500");

const SectionBreakdown = ({ breakdown, compact = false, className }) => {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return null;

  if (compact) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {breakdown.map((s) => (
          <span key={s.section} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700" title={`${s.correctCount} correct · ${s.wrongCount} wrong · ${s.skippedCount} skipped`}>
            <span className="font-medium">{s.section}</span>
            <span className="font-semibold tabular">{s.score}/{s.totalMarks}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <section aria-label="Section-wise score" className={className}>
      <h3 className="mb-2 text-sm font-semibold text-slate-900">Section-wise score</h3>
      <ul className="space-y-3">
        {breakdown.map((s) => (
          <li key={s.section}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium text-slate-800">{s.section}</span>
              <span className="font-semibold tabular text-slate-900">
                {s.score}/{s.totalMarks} <span className="font-normal text-slate-500">({s.percentage}%)</span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={s.percentage} aria-valuemin={0} aria-valuemax={100} aria-label={`${s.section} score`}>
              <div className={cn("h-full rounded-full", barTone(s.percentage))} style={{ width: `${Math.min(100, s.percentage)}%` }} />
            </div>
            <p className="mt-1 text-xs text-slate-500">{s.correctCount} correct · {s.wrongCount} wrong · {s.skippedCount} skipped</p>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default SectionBreakdown;
