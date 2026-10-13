// components/exam/SectionPicker.jsx
// Chooses which section newly added questions go into and shows how many each has.
import React from "react";
import { cn } from "../../utils/cn";

const SectionPicker = ({ sections, active, counts, onChange }) => (
  sections.length === 0 ? null : (
  <div role="radiogroup" aria-label="Section for new questions" className="flex flex-wrap items-center gap-2">
    <span className="text-xs font-medium text-slate-500">Add to section:</span>
    {sections.map((s) => {
      const on = active === s;
      return (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={on}
          onClick={() => onChange(s)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
            on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-brand-400"
          )}
        >
          {s}
          <span className={cn("rounded-full px-1.5 tabular text-[11px]", on ? "bg-white/20" : "bg-slate-100 text-slate-600")}>{counts[s] ?? 0}</span>
        </button>
      );
    })}
  </div>
  )
);

export default SectionPicker;
