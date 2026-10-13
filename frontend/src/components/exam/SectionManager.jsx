// components/exam/SectionManager.jsx
// Lets the admin define this exam's sections: add, rename, reorder, remove.
//   sections: string[]                       counts: { [name]: questionCount }
//   onChange({ sections, rename? })          rename = { from, to } so the page can re-label questions
import React, { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, AlertCircle, Layers } from "lucide-react";
import { Button, IconButton, Card, CardHeader } from "../ui";
import { MAX_SECTIONS, MAX_SECTION_NAME_LEN, tidyName, validateSectionName } from "../../utils/sections";

const SectionRow = ({ name, index, total, count, sections, onChange, onError }) => {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const commit = () => {
    const next = tidyName(draft);
    if (!next || next === name) { setDraft(name); return; }
    const err = validateSectionName(next, sections, index);
    if (err) { onError(err); setDraft(name); return; }
    onError("");
    onChange({ sections: sections.map((s, i) => (i === index ? next : s)), rename: { from: name, to: next } });
  };

  const move = (dir) => {
    const next = [...sections];
    [next[index], next[index + dir]] = [next[index + dir], next[index]];
    onChange({ sections: next });
  };

  return (
    <li className="flex items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-bold text-slate-600 tabular">{index + 1}</span>
      <input
        className="input h-9 min-w-0 flex-1"
        value={draft}
        maxLength={MAX_SECTION_NAME_LEN}
        aria-label={`Section ${index + 1} name`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === "Escape") { setDraft(name); e.currentTarget.blur(); }
        }}
      />
      <span className="w-20 shrink-0 text-right text-xs text-slate-500 tabular">{count} question{count === 1 ? "" : "s"}</span>
      <IconButton icon={ArrowUp} label={`Move ${name} up`} size="sm" disabled={index === 0} onClick={() => move(-1)} />
      <IconButton icon={ArrowDown} label={`Move ${name} down`} size="sm" disabled={index === total - 1} onClick={() => move(1)} />
      <IconButton
        icon={Trash2}
        size="sm"
        variant="danger-ghost"
        label={count > 0 ? `${name} has questions — move or delete them first` : `Remove ${name}`}
        disabled={count > 0}
        onClick={() => { onError(""); onChange({ sections: sections.filter((_, i) => i !== index) }); }}
      />
    </li>
  );
};

const SectionManager = ({ sections, counts, onChange }) => {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  const add = () => {
    const err = validateSectionName(newName, sections);
    if (err) { setError(err); return; }
    setError("");
    onChange({ sections: [...sections, tidyName(newName)] });
    setNewName("");
  };

  return (
    <Card>
      <CardHeader title="Sections" icon={Layers} description="Name the parts of this paper (e.g. Aptitude, Verbal). Students see them in this order. Leave empty for a single un-sectioned paper." />
      <div className="card-body space-y-3">
        {sections.length > 0 && (
          <ul className="space-y-2">
            {sections.map((name, i) => (
              <SectionRow
                key={i}
                name={name}
                index={i}
                total={sections.length}
                count={counts[name] ?? 0}
                sections={sections}
                onChange={onChange}
                onError={setError}
              />
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <input
            className="input h-9 min-w-0 flex-1"
            value={newName}
            maxLength={MAX_SECTION_NAME_LEN}
            placeholder={sections.length >= MAX_SECTIONS ? `Limit of ${MAX_SECTIONS} reached` : "New section name…"}
            aria-label="New section name"
            disabled={sections.length >= MAX_SECTIONS}
            onChange={(e) => { setNewName(e.target.value); if (error) setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          />
          <Button variant="secondary" icon={Plus} onClick={add} disabled={!newName.trim() || sections.length >= MAX_SECTIONS}>Add section</Button>
        </div>

        {error && <p className="field-error" role="alert"><AlertCircle className="h-3.5 w-3.5" />{error}</p>}
      </div>
    </Card>
  );
};

export default SectionManager;
