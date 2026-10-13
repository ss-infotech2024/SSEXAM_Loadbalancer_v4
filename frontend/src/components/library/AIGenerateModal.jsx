// components/library/AIGenerateModal.jsx
// Ask the AI for questions on a topic, review the drafts, then either
//   mode="library" → save the chosen ones to the question library, or
//   mode="exam"    → hand them to the exam editor (optionally saving to the library too).
// Nothing is stored until the admin confirms here.
import React, { useEffect, useId, useState } from "react";
import { Sparkles, RefreshCw, ArrowLeft, Copy } from "lucide-react";
import API from "@/services/api";
import { Modal, Button, Field, Input, Select, Alert, Badge, useToast } from "../ui";
import QuestionPreview from "./QuestionPreview";
import { DIFFICULTIES, MAX_TOPIC_LEN, AI_MAX_QUESTIONS, errMsg } from "../../utils/library";
import { cn } from "../../utils/cn";

const AIGenerateModal = ({ mode = "library", topics = [], defaultTopic = "", onClose, onDone }) => {
  const toast = useToast();
  const uid = useId();

  const [status, setStatus] = useState({ loading: true, enabled: false });
  const [form, setForm] = useState({ topic: defaultTopic, difficulty: "medium", count: 5, language: "English", instructions: "" });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState(null);          // null = still on the form
  const [picked, setPicked] = useState({});            // index → true
  const [alsoSave, setAlsoSave] = useState(true);      // exam mode only
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    API.get("/admin/question-library/ai-status")
      .then((r) => live && setStatus({ loading: false, enabled: !!r.data.enabled }))
      .catch(() => live && setStatus({ loading: false, enabled: false }));
    return () => { live = false; };
  }, []);

  const set = (patch) => { setForm((p) => ({ ...p, ...patch })); setError(""); };

  const generate = async () => {
    const topic = form.topic.trim();
    if (!topic) { setError("Enter a topic"); return; }
    const count = Math.min(AI_MAX_QUESTIONS, Math.max(1, Number(form.count) || 1));
    setGenerating(true); setError("");
    try {
      const res = await API.post("/admin/question-library/generate", { ...form, topic, count }, { timeout: 90000 });
      const qs = res.data.questions || [];
      setDrafts(qs);
      setPicked(Object.fromEntries(qs.map((q, i) => [i, !q.duplicate])));   // duplicates start unticked
      if (qs.length < count) toast(`The AI returned ${qs.length} of ${count} usable questions.`, "info");
    } catch (err) {
      setError(errMsg(err, "Could not generate questions."));
    } finally {
      setGenerating(false);
    }
  };

  const chosen = drafts ? drafts.filter((_, i) => picked[i]) : [];
  const strip = ({ duplicate: _d, ...q }) => q;

  const confirm = async () => {
    if (!chosen.length) return;
    setSaving(true);
    try {
      if (mode === "library" || alsoSave) {
        try {
          const res = await API.post("/admin/question-library/bulk", { questions: chosen.map(strip), source: "ai" });
          toast(res.data.message);
        } catch (err) {
          if (mode === "library") throw err;
          toast(`Couldn't save to the library: ${errMsg(err)}`, "error");   // still add to the exam
        }
      }
      onDone?.(chosen.map(strip));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const busy = generating || saving;

  const footer = !drafts ? (
    <>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button icon={Sparkles} onClick={generate} loading={generating} disabled={!status.enabled}>
        {generating ? "Generating…" : "Generate"}
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" icon={ArrowLeft} onClick={() => { setDrafts(null); setError(""); }} disabled={busy}>Back</Button>
      <Button variant="secondary" icon={RefreshCw} onClick={generate} loading={generating} disabled={saving}>Regenerate</Button>
      <Button onClick={confirm} loading={saving} disabled={!chosen.length || generating}>
        {mode === "library" ? `Save ${chosen.length} to library` : `Add ${chosen.length} to exam`}
      </Button>
    </>
  );

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      dismissible={!busy}
      size="lg"
      icon={Sparkles}
      title="Generate questions with AI"
      description={drafts ? "Review the drafts. Untick any you don't want." : "Describe what you need — you'll review everything before anything is saved."}
      footer={footer}
    >
      {status.loading ? (
        <p className="py-6 text-center text-sm text-slate-500">Checking AI availability…</p>
      ) : !status.enabled ? (
        <Alert tone="warning">
          AI generation isn't switched on for this server yet. Ask whoever runs the backend to add an AI API key (for example <code className="rounded bg-amber-100 px-1">GEMINI_API_KEY</code>) to the backend environment and restart it.
        </Alert>
      ) : !drafts ? (
        <div className="space-y-4">
          <Field label="Topic" required hint="Be specific — e.g. “Time and work”, “Subject–verb agreement”, “Binary trees”">
            {(p) => (
              <>
                <Input {...p} data-autofocus list={`${uid}-topics`} value={form.topic} maxLength={MAX_TOPIC_LEN} onChange={(e) => set({ topic: e.target.value })} />
                <datalist id={`${uid}-topics`}>{topics.map((t) => <option key={t.name} value={t.name} />)}</datalist>
              </>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Difficulty">
              {(p) => <Select {...p} value={form.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>{DIFFICULTIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select>}
            </Field>
            <Field label="How many" hint={`1–${AI_MAX_QUESTIONS}`}>
              {(p) => <Input {...p} type="number" min={1} max={AI_MAX_QUESTIONS} value={form.count} onChange={(e) => set({ count: e.target.value })} />}
            </Field>
            <Field label="Language">
              {(p) => <Input {...p} value={form.language} maxLength={30} onChange={(e) => set({ language: e.target.value })} />}
            </Field>
          </div>
          <Field label="Extra instructions (optional)" hint="e.g. “Use Indian rupees in examples”, “Campus placement level”">
            {({ invalid: _invalid, ...p }) => <textarea {...p} rows={2} maxLength={500} className="input resize-y" value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} />}
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      ) : (
        <div className="space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{chosen.length} of {drafts.length} selected</span>
            <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => setPicked(Object.fromEntries(drafts.map((_, i) => [i, chosen.length !== drafts.length])))}>
              {chosen.length === drafts.length ? "Untick all" : "Tick all"}
            </button>
          </div>
          <ul className="space-y-2.5">
            {drafts.map((q, i) => (
              <li key={i} className={cn("rounded-lg border p-3", picked[i] ? "border-brand-300 bg-brand-50/30" : "border-slate-200")}>
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={!!picked[i]} onChange={(e) => setPicked((p) => ({ ...p, [i]: e.target.checked }))} aria-label={`Select question ${i + 1}`} />
                  <div className="min-w-0 flex-1">
                    {q.duplicate && <Badge tone="warning" icon={Copy} className="mb-1.5">Already in your library</Badge>}
                    <QuestionPreview question={q} />
                  </div>
                </label>
              </li>
            ))}
          </ul>
          {mode === "exam" && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={alsoSave} onChange={(e) => setAlsoSave(e.target.checked)} />
              Also save these to the question library
            </label>
          )}
          <p className="text-xs text-slate-500">AI can make mistakes — check each answer before using it in an exam.</p>
        </div>
      )}
    </Modal>
  );
};

export default AIGenerateModal;
