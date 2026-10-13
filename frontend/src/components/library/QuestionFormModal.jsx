// components/library/QuestionFormModal.jsx — add or edit one library question.
import React, { useId, useState } from "react";
import { AlertCircle } from "lucide-react";
import API from "@/services/api";
import { Modal, Button, Field, Input, Select, useToast } from "../ui";
import { DIFFICULTIES, MAX_TOPIC_LEN, errMsg } from "../../utils/library";
import { cn } from "../../utils/cn";

const LETTERS = ["A", "B", "C", "D"];
const blank = { text: "", options: ["", "", "", ""], correctAnswer: null, explanation: "", topic: "", difficulty: "medium" };

// Mount only while open (parent renders it conditionally) so the form always starts fresh.
const QuestionFormModal = ({ question, topics = [], defaultTopic = "", onClose, onSaved }) => {
  const toast = useToast();
  const uid = useId();
  const editing = !!question?._id;
  const [form, setForm] = useState(question
    ? { ...blank, ...question, options: [...question.options] }
    : { ...blank, topic: defaultTopic });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");

  const set = (patch) => { setForm((p) => ({ ...p, ...patch })); setServerError(""); };
  const setOption = (i, v) => set({ options: form.options.map((o, j) => (j === i ? v : o)) });

  const validate = () => {
    const e = {};
    if (!form.text.trim()) e.text = "Question text is required";
    form.options.forEach((o, i) => { if (!o.trim()) e[`opt${i}`] = `Option ${LETTERS[i]} is required`; });
    if (form.correctAnswer === null) e.correct = "Select the correct answer";
    if (form.topic.trim().length > MAX_TOPIC_LEN) e.topic = `Max ${MAX_TOPIC_LEN} characters`;
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const body = {
        text: form.text.trim(), options: form.options.map((o) => o.trim()), correctAnswer: form.correctAnswer,
        explanation: form.explanation.trim(), topic: form.topic.trim(), difficulty: form.difficulty,
      };
      const res = editing ? await API.put(`/admin/question-library/${question._id}`, body) : await API.post("/admin/question-library", body);
      toast(res.data.message || "Saved");
      onSaved?.(res.data.question);
    } catch (err) {
      setServerError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="lg"
      title={editing ? "Edit library question" : "Add library question"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving}>{editing ? "Save changes" : "Add to library"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Question" required error={errors.text}>
          {({ invalid: _invalid, ...p }) => <textarea {...p} data-autofocus rows={3} className={cn("input min-h-[72px] resize-y", errors.text && "input-invalid")} value={form.text} onChange={(e) => set({ text: e.target.value })} />}
        </Field>

        <fieldset>
          <legend className="label">Options — select the correct answer <span className="text-rose-600" aria-hidden="true">*</span></legend>
          <div className="mt-1.5 space-y-2">
            {form.options.map((o, i) => (
              <div key={i}>
                <div className="flex items-center gap-2">
                  <input
                    type="radio" name={`${uid}-correct`} checked={form.correctAnswer === i}
                    onChange={() => set({ correctAnswer: i })} aria-label={`Option ${LETTERS[i]} is correct`}
                    className="h-4 w-4 accent-emerald-600"
                  />
                  <span className="w-4 text-xs font-bold text-slate-500">{LETTERS[i]}</span>
                  <input
                    className={cn("input h-9 flex-1", errors[`opt${i}`] && "input-invalid")} value={o}
                    aria-label={`Option ${LETTERS[i]}`} aria-invalid={errors[`opt${i}`] ? true : undefined}
                    onChange={(e) => setOption(i, e.target.value)}
                  />
                </div>
                {errors[`opt${i}`] && <p className="field-error ml-10"><AlertCircle className="h-3.5 w-3.5" />{errors[`opt${i}`]}</p>}
              </div>
            ))}
          </div>
          {errors.correct && <p className="field-error"><AlertCircle className="h-3.5 w-3.5" />{errors.correct}</p>}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Topic" hint="Used to group and filter questions" error={errors.topic}>
            {(p) => (
              <>
                <Input {...p} list={`${uid}-topics`} value={form.topic} maxLength={MAX_TOPIC_LEN} placeholder="e.g. Percentages" onChange={(e) => set({ topic: e.target.value })} />
                <datalist id={`${uid}-topics`}>{topics.map((t) => <option key={t.name} value={t.name} />)}</datalist>
              </>
            )}
          </Field>
          <Field label="Difficulty">
            {(p) => (
              <Select {...p} value={form.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>
                {DIFFICULTIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </Select>
            )}
          </Field>
        </div>

        <Field label="Explanation (optional)" hint="For your reference only — students never see it.">
          {({ invalid: _invalid, ...p }) => <textarea {...p} rows={2} maxLength={1000} className="input resize-y" value={form.explanation} onChange={(e) => set({ explanation: e.target.value })} />}
        </Field>

        {serverError && <p className="field-error" role="alert"><AlertCircle className="h-3.5 w-3.5" />{serverError}</p>}
      </div>
    </Modal>
  );
};

export default QuestionFormModal;
