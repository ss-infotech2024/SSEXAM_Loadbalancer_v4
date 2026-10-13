// components/library/QuestionPreview.jsx — read-only view of one MCQ with the correct option highlighted.
import React from "react";
import { CheckCircle2 } from "lucide-react";
import { cn } from "../../utils/cn";

const LETTERS = ["A", "B", "C", "D"];

const QuestionPreview = ({ question: q, showExplanation = true, hideText = false, className }) => (
  <div className={className}>
    {!hideText && <p className="whitespace-pre-wrap text-sm font-medium text-slate-900">{q.text}</p>}
    <ol className={cn("grid gap-1.5 sm:grid-cols-2", !hideText && "mt-2")}>
      {q.options.map((o, i) => {
        const correct = i === q.correctAnswer;
        return (
          <li
            key={i}
            className={cn(
              "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm",
              correct ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-white text-slate-700"
            )}
          >
            <span className={cn("mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-bold", correct ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600")}>
              {LETTERS[i]}
            </span>
            <span className="min-w-0 flex-1 break-words">{o}</span>
            {correct && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Correct answer" />}
          </li>
        );
      })}
    </ol>
    {showExplanation && q.explanation ? <p className="mt-2 text-xs text-slate-500"><span className="font-semibold text-slate-600">Why: </span>{q.explanation}</p> : null}
  </div>
);

export default QuestionPreview;
