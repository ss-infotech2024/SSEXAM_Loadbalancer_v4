// components/exam/QuestionEditorCard.jsx
// One MCQ in the Create / Edit exam forms: text, four options, one correct answer.
// onChange(field, value, optIdx) mirrors the pages' updateQuestion(id, field, value, optIdx).
import React, { useId } from "react";
import { AlertCircle, CheckCircle2, Trash2 } from "lucide-react";
import { Badge, IconButton } from "../ui";
import { cn } from "../../utils/cn";

const QuestionEditorCard = ({ index, question: q, sections = [], marks, errors, onChange, onRemove, inputRef }) => {
  const uid = useId();
  const textErr = errors[`q-${q.id}-text`];
  const correctErr = errors[`q-${q.id}-correct`];
  const answered = q.correctAnswer !== null && q.correctAnswer !== undefined;
  const sectionErr = errors[`q-${q.id}-section`];
  const optErrors = q.options.map((_, i) => errors[`q-${q.id}-opt${i}`]).filter(Boolean);

  return (
    <article
      className={cn("card p-4 sm:p-5", (textErr || correctErr || sectionErr || optErrors.length) && "border-rose-200")}
      aria-labelledby={`${uid}-title`}
    >
      <header className="mb-3 flex items-center gap-2">
        <span className="flex h-7 min-w-7 items-center justify-center rounded-md bg-slate-900 px-1.5 text-xs font-bold text-white tabular">
          {index + 1}
        </span>
        <h3 id={`${uid}-title`} className="text-sm font-semibold text-slate-900">Question {index + 1}</h3>
        {marks ? <Badge tone="brand">{marks} mark{Number(marks) > 1 ? "s" : ""}</Badge> : null}
        {answered
          ? <Badge tone="success" icon={CheckCircle2} className="hidden sm:inline-flex">Answer set</Badge>
          : <Badge tone="warning" icon={AlertCircle} className="hidden sm:inline-flex">No answer</Badge>}
        {(sections.length > 0 || q.section) && <label htmlFor={`${uid}-section`} className="sr-only">Question {index + 1} section</label>}
        {(sections.length > 0 || q.section) && <select
          id={`${uid}-section`}
          value={sections.includes(q.section) ? q.section : ""}
          onChange={(e) => onChange("section", e.target.value)}
          aria-invalid={sectionErr ? true : undefined}
          className={cn("input ml-auto h-8 w-auto py-0 text-xs font-medium", sectionErr && "input-invalid")}
        >
          {(!q.section || !sections.includes(q.section)) && <option value="">{sectionErr ? "Choose a section" : "No section"}</option>}
          {sections.map((sec) => <option key={sec} value={sec}>{sec}</option>)}
        </select>}
        <IconButton icon={Trash2} label={`Remove question ${index + 1}`} size="sm" variant="danger-ghost" className={!(sections.length > 0 || q.section) ? "ml-auto" : undefined} onClick={onRemove} />
      </header>

      <label htmlFor={`${uid}-text`} className="sr-only">Question {index + 1} text</label>
      <textarea
        id={`${uid}-text`}
        ref={inputRef}
        rows={2}
        value={q.text}
        onChange={(e) => onChange("text", e.target.value)}
        placeholder="Type the question…"
        aria-invalid={textErr ? true : undefined}
        className={cn("input min-h-[64px] resize-y", textErr && "input-invalid")}
      />
      {textErr && <p className="field-error"><AlertCircle className="h-3.5 w-3.5" />{textErr}</p>}

      <fieldset className="mt-3">
        <legend className="mb-2 text-xs font-medium text-slate-500">Options — select the correct answer</legend>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {q.options.map((opt, optIdx) => {
            const isCorrect = q.correctAnswer === optIdx;
            const optErr = errors[`q-${q.id}-opt${optIdx}`];
            const letter = String.fromCharCode(65 + optIdx);
            return (
              <div
                key={optIdx}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors focus-within:ring-4 focus-within:ring-brand-500/15",
                  isCorrect ? "border-emerald-300 bg-emerald-50/70" : optErr ? "border-rose-300 bg-rose-50/40" : "border-slate-200 bg-white"
                )}
              >
                <label className="flex shrink-0 cursor-pointer items-center gap-2" title={`Mark option ${letter} as correct`}>
                  <input
                    type="radio"
                    name={`correct-${q.id}`}
                    value={optIdx}
                    checked={isCorrect}
                    onChange={(e) => onChange("correctAnswer", e.target.value)}
                    className="h-4 w-4 accent-emerald-600"
                    aria-label={`Option ${letter} is correct`}
                  />
                  <span
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold",
                      isCorrect ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"
                    )}
                  >
                    {letter}
                  </span>
                </label>
                <input
                  type="text"
                  value={opt}
                  onChange={(e) => onChange("option", e.target.value, optIdx)}
                  placeholder={`Option ${letter}`}
                  aria-label={`Option ${letter}`}
                  aria-invalid={optErr ? true : undefined}
                  className="min-w-0 flex-1 bg-transparent py-1 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                />
              </div>
            );
          })}
        </div>
      </fieldset>

      {(optErrors.length > 0 || correctErr) && (
        <p className="field-error">
          <AlertCircle className="h-3.5 w-3.5" />
          {[optErrors.length ? "Fill in all four options" : null, correctErr].filter(Boolean).join(" · ")}
        </p>
      )}
    </article>
  );
};

export default QuestionEditorCard;
