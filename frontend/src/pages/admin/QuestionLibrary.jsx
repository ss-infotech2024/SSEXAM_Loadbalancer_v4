// pages/admin/QuestionLibrary.jsx — the department's reusable question bank.
import React, { useCallback, useEffect, useState } from "react";
import { Library, Plus, Sparkles, Pencil, Trash2, ChevronDown, Inbox, Bot, Building2 } from "lucide-react";
import API from "@/services/api";
import {
  PageHeader, Button, IconButton, Card, SearchInput, Select, Badge, Pagination,
  ConfirmDialog, EmptyState, ErrorState, Skeleton, StatCard, useToast,
} from "../../components/ui";
import QuestionPreview from "../../components/library/QuestionPreview";
import QuestionFormModal from "../../components/library/QuestionFormModal";
import AIGenerateModal from "../../components/library/AIGenerateModal";
import { DIFFICULTIES, difficultyMeta, errMsg } from "../../utils/library";
import { cn } from "../../utils/cn";

const PAGE = 15;

const LibraryRow = ({ q, selected, onSelect, onEdit, onDelete }) => {
  const [open, setOpen] = useState(false);
  const diff = difficultyMeta(q.difficulty);
  return (
    <li className={cn("flex items-start gap-3 px-4 py-3", selected && "bg-brand-50/40")}>
      <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-brand-600" checked={selected} onChange={onSelect} aria-label={`Select: ${q.text.slice(0, 60)}`} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          {q.topic ? <Badge tone="brand">{q.topic}</Badge> : <Badge tone="neutral">No topic</Badge>}
          <Badge tone={diff.tone}>{diff.label}</Badge>
          {q.source === "ai" && <Badge tone="info" icon={Bot}>AI</Badge>}
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="group flex w-full items-start gap-2 text-left">
          <span className={cn("whitespace-pre-wrap text-sm font-medium text-slate-900", !open && "line-clamp-2")}>{q.text}</span>
          <ChevronDown className={cn("mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:text-slate-600", open && "rotate-180")} aria-hidden="true" />
        </button>
        {open && <QuestionPreview question={q} hideText className="mt-2" />}
      </div>
      <div className="flex shrink-0 gap-1">
        <IconButton icon={Pencil} label="Edit question" size="sm" onClick={onEdit} />
        <IconButton icon={Trash2} label="Delete question" size="sm" variant="danger-ghost" onClick={onDelete} />
      </div>
    </li>
  );
};

const QuestionLibrary = () => {
  const toast = useToast();
  const [filters, setFilters] = useState({ search: "", topic: "", difficulty: "", source: "" });
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ questions: [], total: 0 });
  const [topics, setTopics] = useState({ topics: [], uncategorised: 0, total: 0 });
  const [state, setState] = useState({ loading: true, error: "" });
  const [selected, setSelected] = useState(() => new Set());

  const [form, setForm] = useState(null);          // null | { question? }
  const [aiOpen, setAiOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState(null); // null | string[]
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(filters.search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [filters.search]);

  const loadTopics = useCallback(async () => {
    try { setTopics((await API.get("/admin/question-library/topics")).data); } catch { /* filters just stay empty */ }
  }, []);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const res = await API.get("/admin/question-library", {
        params: { search: debounced, topic: filters.topic, difficulty: filters.difficulty, source: filters.source, page, limit: PAGE },
      });
      // asked for a page that no longer exists (e.g. after deleting the last item on it)
      if (res.data.questions.length === 0 && page > 1) { setPage(res.data.pages); return; }
      setData({ questions: res.data.questions, total: res.data.total });
      setState({ loading: false, error: "" });
    } catch (err) {
      setState({ loading: false, error: errMsg(err, "Couldn't load the question library.") });
    }
  }, [debounced, filters.topic, filters.difficulty, filters.source, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTopics(); }, [loadTopics]);

  const refresh = () => { setSelected(new Set()); load(); loadTopics(); };
  const setFilter = (patch) => { setFilters((p) => ({ ...p, ...patch })); setPage(1); setSelected(new Set()); };
  const filtered = !!(filters.search || filters.topic || filters.difficulty || filters.source);

  const pageIds = data.questions.map((q) => q._id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const togglePage = () => setSelected((s) => { const n = new Set(s); pageIds.forEach((id) => (allOnPage ? n.delete(id) : n.add(id))); return n; });

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const res = deleteIds.length === 1
        ? await API.delete(`/admin/question-library/${deleteIds[0]}`)
        : await API.post("/admin/question-library/bulk-delete", { ids: deleteIds });
      toast(res.data.message);
      setDeleteIds(null);
      refresh();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setDeleting(false);
    }
  };

  const adminDept = localStorage.getItem("adminDepartment") || "";

  return (
    <>
      <PageHeader
        title="Question library"
        description="Reusable questions for your department. Add them to any exam while you build it."
        eyebrow={adminDept && <Badge tone="brand" icon={Building2}>{adminDept} department</Badge>}
        actions={
          <>
            <Button variant="secondary" icon={Sparkles} onClick={() => setAiOpen(true)}>Generate with AI</Button>
            <Button icon={Plus} onClick={() => setForm({})}>Add question</Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Questions" value={topics.total} icon={Library} tone="brand" />
        <StatCard label="Topics" value={topics.topics.length} icon={Library} tone="info" />
        <StatCard label="No topic" value={topics.uncategorised} icon={Inbox} tone="neutral" />
      </div>

      <Card>
        <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[1fr_190px_150px_130px]">
          <SearchInput value={filters.search} onChange={(v) => { setFilters((p) => ({ ...p, search: v })); setSelected(new Set()); }} placeholder="Search questions…" />
          <Select aria-label="Topic" value={filters.topic} onChange={(e) => setFilter({ topic: e.target.value })}>
            <option value="">All topics</option>
            {topics.uncategorised > 0 && <option value="__none__">No topic ({topics.uncategorised})</option>}
            {topics.topics.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
          </Select>
          <Select aria-label="Difficulty" value={filters.difficulty} onChange={(e) => setFilter({ difficulty: e.target.value })}>
            <option value="">Any difficulty</option>
            {DIFFICULTIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </Select>
          <Select aria-label="Source" value={filters.source} onChange={(e) => setFilter({ source: e.target.value })}>
            <option value="">Any source</option>
            <option value="manual">Typed in</option>
            <option value="ai">AI</option>
            <option value="exam">From an exam</option>
          </Select>
        </div>

        {data.questions.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-2">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={allOnPage} onChange={togglePage} />
              {selected.size > 0 ? `${selected.size} selected` : "Select this page"}
            </label>
            {selected.size > 0 && <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDeleteIds([...selected])}>Delete {selected.size}</Button>}
          </div>
        )}

        {state.error ? (
          <ErrorState message={state.error} onRetry={load} />
        ) : state.loading && data.questions.length === 0 ? (
          <div className="space-y-3 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : data.questions.length === 0 ? (
          <EmptyState
            icon={Library}
            title={filtered ? "No questions match these filters" : "Your library is empty"}
            description={filtered ? "Try clearing a filter." : "Add questions one by one, or let AI draft a set on any topic for you to review."}
            action={!filtered && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button icon={Sparkles} onClick={() => setAiOpen(true)}>Generate with AI</Button>
                <Button variant="secondary" icon={Plus} onClick={() => setForm({})}>Add question</Button>
              </div>
            )}
          />
        ) : (
          <ul className={cn("divide-y divide-slate-100", state.loading && "opacity-60")}>
            {data.questions.map((q) => (
              <LibraryRow key={q._id} q={q} selected={selected.has(q._id)} onSelect={() => toggleOne(q._id)} onEdit={() => setForm({ question: q })} onDelete={() => setDeleteIds([q._id])} />
            ))}
          </ul>
        )}

        {!state.error && <Pagination page={page} pageSize={PAGE} total={data.total} onChange={(p) => { setPage(p); setSelected(new Set()); }} />}
      </Card>

      {form && (
        <QuestionFormModal
          question={form.question}
          topics={topics.topics}
          defaultTopic={filters.topic && filters.topic !== "__none__" ? filters.topic : ""}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); refresh(); }}
        />
      )}

      {aiOpen && (
        <AIGenerateModal
          mode="library"
          topics={topics.topics}
          defaultTopic={filters.topic && filters.topic !== "__none__" ? filters.topic : ""}
          onClose={() => setAiOpen(false)}
          onDone={() => { setAiOpen(false); refresh(); }}
        />
      )}

      {deleteIds && (
        <ConfirmDialog
          title={deleteIds.length === 1 ? "Delete this question?" : `Delete ${deleteIds.length} questions?`}
          message="They'll be removed from the library. Exams that already use them are not affected."
          confirmLabel="Delete"
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteIds(null)}
        />
      )}
    </>
  );
};

export default QuestionLibrary;
