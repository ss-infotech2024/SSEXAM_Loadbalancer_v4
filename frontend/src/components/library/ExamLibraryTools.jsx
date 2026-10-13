// components/library/ExamLibraryTools.jsx
// Buttons + dialogs used inside Create Exam / Edit Exam to work with the question library:
//   • From library          — pick stored questions and copy them into the exam
//   • Generate with AI      — draft new questions (optionally saved to the library too)
//   • Save to library       — store this exam's finished questions for reuse
// The page owns its question list; this component only calls onAdd([{ text, options, correctAnswer }]).
import React, { useMemo, useState } from "react";
import { Library, Sparkles, BookmarkPlus } from "lucide-react";
import API from "@/services/api";
import { Button, useToast } from "../ui";
import LibraryPickerModal from "./LibraryPickerModal";
import AIGenerateModal from "./AIGenerateModal";
import { isCompleteQuestion, normalizeText, errMsg } from "../../utils/library";

const ExamLibraryTools = ({ questions, sectionName, subject, onAdd }) => {
  const toast = useToast();
  const [picker, setPicker] = useState(false);
  const [ai, setAi] = useState(false);
  const [topics, setTopics] = useState([]);
  const [saving, setSaving] = useState(false);

  const existingTexts = useMemo(() => new Set(questions.map((q) => normalizeText(q.text)).filter(Boolean)), [questions]);
  const target = sectionName ? `New questions go into the “${sectionName}” section.` : "Questions are added to the end of the exam.";

  const open = async (which) => {
    // topics feed the filter / suggestion lists; failing to load them must not block the dialog
    try { setTopics((await API.get("/admin/question-library/topics")).data.topics || []); } catch { setTopics([]); }
    which === "picker" ? setPicker(true) : setAi(true);
  };

  const added = (list, via) => {
    onAdd(list.map(({ text, options, correctAnswer }) => ({ text, options: [...options], correctAnswer })));
    toast(`Added ${list.length} question${list.length === 1 ? "" : "s"} ${via}. Don't forget to save the exam.`);
  };

  const saveToLibrary = async () => {
    const ready = questions.filter(isCompleteQuestion);
    if (!ready.length) { toast("Finish at least one question (text, 4 options and the correct answer) first.", "error"); return; }
    setSaving(true);
    try {
      const res = await API.post("/admin/question-library/bulk", {
        source: "exam",
        questions: ready.map((q) => ({
          text: q.text.trim(), options: q.options.map((o) => o.trim()), correctAnswer: q.correctAnswer,
          topic: (q.section || subject || "").slice(0, 100),
        })),
      });
      toast(`${res.data.message}${ready.length < questions.length ? ` ${questions.length - ready.length} unfinished question(s) were left out.` : ""}`);
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="secondary" icon={Library} onClick={() => open("picker")}>From library</Button>
      <Button variant="secondary" icon={Sparkles} onClick={() => open("ai")}>Generate with AI</Button>
      <Button variant="ghost" icon={BookmarkPlus} loading={saving} disabled={questions.length === 0} onClick={saveToLibrary}>Save to library</Button>

      {picker && (
        <LibraryPickerModal
          topics={topics}
          existingTexts={existingTexts}
          targetLabel={target}
          onClose={() => setPicker(false)}
          onAdd={(list) => { setPicker(false); added(list, "from the library"); }}
        />
      )}
      {ai && (
        <AIGenerateModal
          mode="exam"
          topics={topics}
          defaultTopic={sectionName || ""}
          onClose={() => setAi(false)}
          onDone={(list) => { setAi(false); added(list, "from AI"); }}
        />
      )}
    </>
  );
};

export default ExamLibraryTools;
