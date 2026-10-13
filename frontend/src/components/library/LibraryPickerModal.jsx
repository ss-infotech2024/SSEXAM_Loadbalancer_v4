// components/library/LibraryPickerModal.jsx — choose library questions to copy into the exam being edited.
import React, { useCallback, useEffect, useState } from "react";
import { Library, Inbox } from "lucide-react";
import API from "@/services/api";
import { Modal, Button, SearchInput, Select, Badge, Pagination, EmptyState, ErrorState, Skeleton } from "../ui";
import QuestionPreview from "./QuestionPreview";
import { DIFFICULTIES, difficultyMeta, normalizeText, errMsg } from "../../utils/library";
import { cn } from "../../utils/cn";

const PAGE = 8;

// existingTexts: Set of normalizeText() values already in the exam (shown as "In this exam", can't be picked again)
const LibraryPickerModal = ({ topics = [], existingTexts = new Set(), targetLabel, onClose, onAdd }) => {
  const [filters, setFilters] = useState({ search: "", topic: "", difficulty: "" });
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ questions: [], total: 0 });
  const [state, setState] = useState({ loading: true, error: "" });
  const [picked, setPicked] = useState(() => new Map());   // _id → question (kept across pages / filters)

  useEffect(() => { const t = setTimeout(() => { setDebounced(filters.search); setPage(1); }, 300); return () => clearTimeout(t); }, [filters.search]);

  const load = useCallback(async () => {
    setState({ loading: true, error: "" });
    try {
      const res = await API.get("/admin/question-library", { params: { search: debounced, topic: filters.topic, difficulty: filters.difficulty, page, limit: PAGE } });
      setData({ questions: res.data.questions, total: res.data.total });
      setState({ loading: false, error: "" });
    } catch (err) {
      setState({ loading: false, error: errMsg(err, "Couldn't load the library.") });
    }
  }, [debounced, filters.topic, filters.difficulty, page]);
  useEffect(() => { load(); }, [load]);

  const setFilter = (patch) => { setFilters((p) => ({ ...p, ...patch })); setPage(1); };
  const toggle = (q) => setPicked((prev) => { const m = new Map(prev); m.has(q._id) ? m.delete(q._id) : m.set(q._id, q); return m; });

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      icon={Library}
      title="Add from question library"
      description={targetLabel}
      footer={
        <>
          <span className="mr-auto text-sm text-slate-500">{picked.size} selected</span>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={picked.size === 0} onClick={() => onAdd([...picked.values()])}>Add {picked.size || ""} to exam</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_180px_150px]">
          <SearchInput value={filters.search} onChange={(v) => setFilters((p) => ({ ...p, search: v }))} placeholder="Search questions…" />
          <Select aria-label="Topic" value={filters.topic} onChange={(e) => setFilter({ topic: e.target.value })}>
            <option value="">All topics</option>
            {topics.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
          </Select>
          <Select aria-label="Difficulty" value={filters.difficulty} onChange={(e) => setFilter({ difficulty: e.target.value })}>
            <option value="">Any difficulty</option>
            {DIFFICULTIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </Select>
        </div>

        {state.error ? (
          <ErrorState message={state.error} onRetry={load} />
        ) : state.loading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        ) : data.questions.length === 0 ? (
          <EmptyState icon={Inbox} title="No questions found" description="Add questions on the Question library page, or generate some with AI." />
        ) : (
          <ul className="space-y-2">
            {data.questions.map((q) => {
              const inExam = existingTexts.has(normalizeText(q.text));
              const on = picked.has(q._id);
              const diff = difficultyMeta(q.difficulty);
              return (
                <li key={q._id} className={cn("rounded-lg border p-3", on ? "border-brand-300 bg-brand-50/30" : "border-slate-200", inExam && "opacity-60")}>
                  <label className={cn("flex items-start gap-3", inExam ? "cursor-not-allowed" : "cursor-pointer")}>
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={on} disabled={inExam} onChange={() => toggle(q)} aria-label={`Select: ${q.text.slice(0, 60)}`} />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1.5 flex flex-wrap gap-1.5">
                        {q.topic && <Badge tone="brand">{q.topic}</Badge>}
                        <Badge tone={diff.tone}>{diff.label}</Badge>
                        {inExam && <Badge tone="neutral">Already in this exam</Badge>}
                      </div>
                      <QuestionPreview question={q} showExplanation={false} />
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!state.loading && !state.error && <Pagination page={page} pageSize={PAGE} total={data.total} onChange={setPage} className="mt-2 px-0" />}
    </Modal>
  );
};

export default LibraryPickerModal;
