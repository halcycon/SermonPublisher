import { FormEvent, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type PublishStep = {
  id: string;
  description: string;
};

type PublishPlan = {
  slug: string;
  markdownPath: string;
  websiteAudioPath: string;
  thumbnailPath: string;
  cleanedVideoPath: string;
  markdown: string;
  steps: PublishStep[];
};

type PublishRequest = {
  title: string;
  speaker: string;
  date: string;
  series: string;
  scripture: string;
  summary: string;
  inputVideoPath: string;
  hugoContentDir: string;
  audioOutputDir: string;
  imageOutputDir: string;
  slug?: string;
  leadingSilenceSeconds: number;
  youtubeUploadEnabled: boolean;
};

const today = new Date().toISOString().slice(0, 10);

function App() {
  const [request, setRequest] = useState<PublishRequest>({
    title: "",
    speaker: "",
    date: today,
    series: "",
    scripture: "",
    summary: "",
    inputVideoPath: "",
    hugoContentDir: "content/sermons",
    audioOutputDir: "static/audio/sermons",
    imageOutputDir: "static/images/sermons",
    slug: "",
    leadingSilenceSeconds: 12,
    youtubeUploadEnabled: true,
  });
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [error, setError] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);

  const canPublish = useMemo(
    () => request.title.trim() && request.inputVideoPath.trim(),
    [request.title, request.inputVideoPath]
  );

  const updateField = <K extends keyof PublishRequest>(key: K, value: PublishRequest[K]) => {
    setRequest((previous) => ({ ...previous, [key]: value }));
  };

  async function onPublish(event: FormEvent) {
    event.preventDefault();
    setError("");
    setIsPublishing(true);

    try {
      const nextPlan = await invoke<PublishPlan>("build_publish_plan", { request });
      setPlan(nextPlan);
    } catch (publishError) {
      setPlan(null);
      setError(
        publishError instanceof Error ? publishError.message : "Unable to build publish plan."
      );
    } finally {
      setIsPublishing(false);
    }
  }

  return (
    <main className="container">
      <h1>Sermon Publisher</h1>
      <p className="subtitle">Windows-first publishing workflow for Hugo + Cloudflare Pages</p>

      <form className="publish-form" onSubmit={onPublish}>
        <label>
          Sermon Title
          <input
            value={request.title}
            onChange={(event) => updateField("title", event.currentTarget.value)}
            required
          />
        </label>

        <label>
          Speaker
          <input
            value={request.speaker}
            onChange={(event) => updateField("speaker", event.currentTarget.value)}
          />
        </label>

        <label>
          Date
          <input
            type="date"
            value={request.date}
            onChange={(event) => updateField("date", event.currentTarget.value)}
          />
        </label>

        <label>
          Input Video Path
          <input
            placeholder="C:/recordings/sermon.mp4"
            value={request.inputVideoPath}
            onChange={(event) => updateField("inputVideoPath", event.currentTarget.value)}
            required
          />
        </label>

        <label>
          Series
          <input
            value={request.series}
            onChange={(event) => updateField("series", event.currentTarget.value)}
          />
        </label>

        <label>
          Scripture
          <input
            value={request.scripture}
            onChange={(event) => updateField("scripture", event.currentTarget.value)}
          />
        </label>

        <label>
          Summary
          <textarea
            rows={4}
            value={request.summary}
            onChange={(event) => updateField("summary", event.currentTarget.value)}
          />
        </label>

        <label>
          Leading Silence (seconds)
          <input
            type="number"
            min={1}
            max={120}
            value={request.leadingSilenceSeconds}
            onChange={(event) => updateField("leadingSilenceSeconds", Number(event.currentTarget.value))}
          />
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={request.youtubeUploadEnabled}
            onChange={(event) => updateField("youtubeUploadEnabled", event.currentTarget.checked)}
          />
          Upload cleaned video to YouTube and patch markdown with youtubeID
        </label>

        <button type="submit" disabled={!canPublish || isPublishing}>
          {isPublishing ? "Planning…" : "Publish"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {plan && (
        <section className="plan-card">
          <h2>Publish Plan ({plan.slug})</h2>
          <ul>
            {plan.steps.map((step) => (
              <li key={step.id}>{step.description}</li>
            ))}
          </ul>
          <p><strong>Markdown:</strong> {plan.markdownPath}</p>
          <p><strong>Website audio:</strong> {plan.websiteAudioPath}</p>
          <p><strong>Thumbnail:</strong> {plan.thumbnailPath}</p>
          <p><strong>YouTube video:</strong> {plan.cleanedVideoPath}</p>
        </section>
      )}
    </main>
  );
}

export default App;
