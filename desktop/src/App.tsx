import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

// ── Types ────────────────────────────────────────────────────────────────────

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

type GitHubConfig = {
  owner: string;
  repo: string;
  branch: string;
  token: string;
};

type SeriesInfo = {
  name: string;
  sermonCount: number;
  latestDate: string;
};

type SpeakerInfo = {
  name: string;
  sermonCount: number;
  latestDate: string;
};

type PublishRequest = {
  title: string;
  speaker: string;
  date: string;
  series: string;
  scriptures: string[];
  summary: string;
  inputVideoPath: string;
  hugoContentDir: string;
  audioOutputDir: string;
  imageOutputDir: string;
  slug?: string;
  leadingSilenceSeconds: number;
  youtubeUploadEnabled: boolean;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const LOCAL_STORAGE_KEY = "sermon-publisher-github";
const today = new Date().toISOString().slice(0, 10);

function loadGitHubConfig(): GitHubConfig {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { owner: "", repo: "", branch: "main", token: "" };
}

// ── Component ────────────────────────────────────────────────────────────────

function App() {
  // GitHub settings (persisted to localStorage)
  const [github, setGitHub] = useState<GitHubConfig>(loadGitHubConfig);
  const [settingsOpen, setSettingsOpen] = useState(() => !loadGitHubConfig().owner);

  // Series state
  const [seriesList, setSeriesList] = useState<SeriesInfo[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [newSeriesMode, setNewSeriesMode] = useState(false);

  // Speaker state
  const [speakersList, setSpeakersList] = useState<SpeakerInfo[]>([]);
  const [speakersLoading, setSpeakersLoading] = useState(false);
  const [newSpeakerMode, setNewSpeakerMode] = useState(true);

  // Scripture state (array of references)
  const [scriptures, setScriptures] = useState<string[]>([""]);

  // Silence detection
  const [detectingSilence, setDetectingSilence] = useState(false);

  // Form state
  const [title, setTitle] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [date, setDate] = useState(today);
  const [series, setSeries] = useState("");
  const [summary, setSummary] = useState("");
  const [inputVideoPath, setInputVideoPath] = useState("");
  const [leadingSilenceSeconds, setLeadingSilenceSeconds] = useState(0);
  const [youtubeUploadEnabled, setYoutubeUploadEnabled] = useState(true);
  const [slug, setSlug] = useState("");

  // Output
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [error, setError] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);

  // Persist GitHub config
  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(github));
  }, [github]);

  const updateGitHub = <K extends keyof GitHubConfig>(key: K, value: string) => {
    setGitHub((prev) => ({ ...prev, [key]: value }));
  };

  const githubConfigured = useMemo(
    () => github.owner.trim() && github.repo.trim() && github.token.trim(),
    [github.owner, github.repo, github.token]
  );

  const canPublish = useMemo(
    () => title.trim() && inputVideoPath.trim() && github.owner.trim() && github.repo.trim(),
    [title, inputVideoPath, github.owner, github.repo]
  );

  // ── Scripture helpers ────────────────────────────────────────────────────

  const addScripture = () => setScriptures((prev) => [...prev, ""]);

  const removeScripture = (index: number) => {
    setScriptures((prev) => {
      if (prev.length <= 1) return [""];
      return prev.filter((_, i) => i !== index);
    });
  };

  const updateScripture = (index: number, value: string) => {
    setScriptures((prev) => prev.map((s, i) => (i === index ? value : s)));
  };

  // ── Series fetching ──────────────────────────────────────────────────────

  const fetchSeries = useCallback(async () => {
    if (!githubConfigured) return;
    setSeriesLoading(true);
    setError("");
    try {
      const result = await invoke<SeriesInfo[]>("list_series", {
        githubOwner: github.owner,
        githubRepo: github.repo,
        githubBranch: github.branch || "main",
        githubToken: github.token,
        contentDir: "content/sermons",
      });
      setSeriesList(result);
      if (result.length > 0 && !series) {
        setSeries(result[0].name);
      }
      setNewSeriesMode(result.length === 0);
    } catch (err) {
      setError(
        `Failed to fetch series: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSeriesLoading(false);
    }
  }, [github, githubConfigured, series]);

  // ── Speaker fetching ─────────────────────────────────────────────────

  const fetchSpeakers = useCallback(async () => {
    if (!githubConfigured) return;
    setSpeakersLoading(true);
    setError("");
    try {
      const result = await invoke<SpeakerInfo[]>("list_speakers", {
        githubOwner: github.owner,
        githubRepo: github.repo,
        githubBranch: github.branch || "main",
        githubToken: github.token,
        contentDir: "content/sermons",
      });
      setSpeakersList(result);
      if (result.length > 0 && !speaker) {
        setSpeaker(result[0].name);
      }
      setNewSpeakerMode(result.length === 0);
    } catch (err) {
      setError(
        `Failed to fetch speakers: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSpeakersLoading(false);
    }
  }, [github, githubConfigured, speaker]);

  // ── Silence detection ────────────────────────────────────────────────────

  const detectSilence = useCallback(async () => {
    if (!inputVideoPath.trim()) {
      setError("Enter a video path first");
      return;
    }
    setDetectingSilence(true);
    setError("");
    try {
      const seconds = await invoke<number>("detect_leading_silence", {
        videoPath: inputVideoPath,
      });
      setLeadingSilenceSeconds(seconds);
    } catch (err) {
      setError(
        `Silence detection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setDetectingSilence(false);
    }
  }, [inputVideoPath]);

  // ── Publish ──────────────────────────────────────────────────────────────

  async function onPublish(event: FormEvent) {
    event.preventDefault();
    setError("");
    setIsPublishing(true);

    const request: PublishRequest = {
      title,
      speaker,
      date,
      series,
      scriptures: scriptures.filter((s) => s.trim()),
      summary,
      inputVideoPath,
      hugoContentDir: "content/sermons",
      audioOutputDir: "static/audio/sermons",
      imageOutputDir: "static/images/sermons",
      slug: slug || undefined,
      leadingSilenceSeconds,
      youtubeUploadEnabled,
      githubOwner: github.owner,
      githubRepo: github.repo,
      githubBranch: github.branch || "main",
    };

    try {
      const nextPlan = await invoke<PublishPlan>("build_publish_plan", { request });
      setPlan(nextPlan);
    } catch (publishError) {
      setPlan(null);
      setError(
        publishError instanceof Error
          ? publishError.message
          : String(publishError)
      );
    } finally {
      setIsPublishing(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <main className="container">
      <h1>Sermon Publisher</h1>

      {/* ── GitHub Settings ─────────────────────────────────────────────── */}
      <section className="settings-panel">
        <button
          type="button"
          className="settings-toggle"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <span className="settings-icon">⚙</span>
          GitHub Settings
          {githubConfigured && (
            <span className="settings-badge">
              {github.owner}/{github.repo}
            </span>
          )}
          <span className="chevron">{settingsOpen ? "▲" : "▼"}</span>
        </button>

        {settingsOpen && (
          <div className="settings-fields">
            <label>
              Repository Owner
              <input
                placeholder="my-org"
                value={github.owner}
                onChange={(e) => updateGitHub("owner", e.currentTarget.value)}
              />
            </label>
            <label>
              Repository Name
              <input
                placeholder="church-website"
                value={github.repo}
                onChange={(e) => updateGitHub("repo", e.currentTarget.value)}
              />
            </label>
            <label>
              Branch
              <input
                placeholder="main"
                value={github.branch}
                onChange={(e) => updateGitHub("branch", e.currentTarget.value)}
              />
            </label>
            <label>
              Personal Access Token
              <input
                type="password"
                placeholder="ghp_…"
                value={github.token}
                onChange={(e) => updateGitHub("token", e.currentTarget.value)}
              />
            </label>
          </div>
        )}
      </section>

      {/* ── Publish form ─────────────────────────────────────────────────  */}
      <form className="publish-form" onSubmit={onPublish}>
        {/* Sermon details */}
        <fieldset className="form-section">
          <legend>Sermon Details</legend>

          <label>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              required
            />
          </label>

          <div className="row-2">
            <label>
              Speaker
              <div className="series-row">
                {!newSpeakerMode ? (
                  <select
                    value={speaker}
                    onChange={(e) => setSpeaker(e.currentTarget.value)}
                  >
                    <option value="">— select speaker —</option>
                    {speakersList.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name} ({s.sermonCount})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    placeholder="Speaker name"
                    value={speaker}
                    onChange={(e) => setSpeaker(e.currentTarget.value)}
                  />
                )}
                <button
                  type="button"
                  className="btn-sm"
                  onClick={fetchSpeakers}
                  disabled={speakersLoading || !githubConfigured}
                  title={
                    githubConfigured
                      ? "Fetch speakers from site repo"
                      : "Configure GitHub settings first"
                  }
                >
                  {speakersLoading ? "Loading…" : "↻ Fetch"}
                </button>
                <button
                  type="button"
                  className="btn-sm btn-outline"
                  onClick={() => {
                    setNewSpeakerMode(!newSpeakerMode);
                    if (!newSpeakerMode) setSpeaker("");
                  }}
                >
                  {newSpeakerMode ? "Choose Existing" : "+ New"}
                </button>
              </div>
            </label>
            <label>
              Date
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.currentTarget.value)}
              />
            </label>
          </div>

          {/* Series picker */}
          <label>
            Series
            <div className="series-row">
              {!newSeriesMode ? (
                <select
                  value={series}
                  onChange={(e) => setSeries(e.currentTarget.value)}
                >
                  <option value="">— select series —</option>
                  {seriesList.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name} ({s.sermonCount})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  placeholder="New series name"
                  value={series}
                  onChange={(e) => setSeries(e.currentTarget.value)}
                />
              )}
              <button
                type="button"
                className="btn-sm"
                onClick={fetchSeries}
                disabled={seriesLoading || !githubConfigured}
                title={
                  githubConfigured
                    ? "Fetch series from site repo"
                    : "Configure GitHub settings first"
                }
              >
                {seriesLoading ? "Loading…" : "↻ Fetch"}
              </button>
              <button
                type="button"
                className="btn-sm btn-outline"
                onClick={() => {
                  setNewSeriesMode(!newSeriesMode);
                  if (!newSeriesMode) setSeries("");
                }}
              >
                {newSeriesMode ? "Choose Existing" : "+ New"}
              </button>
            </div>
          </label>

          {/* Scripture references (multiple) */}
          <div className="scripture-section">
            <span className="field-label">Scripture References</span>
            {scriptures.map((s, i) => (
              <div key={i} className="scripture-row">
                <input
                  placeholder="e.g. John 10:1-18"
                  value={s}
                  onChange={(e) => updateScripture(i, e.currentTarget.value)}
                />
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => removeScripture(i)}
                  title="Remove reference"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-sm btn-outline add-scripture"
              onClick={addScripture}
            >
              + Add Reference
            </button>
          </div>

          <label>
            Summary
            <textarea
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.currentTarget.value)}
            />
          </label>
        </fieldset>

        {/* Media */}
        <fieldset className="form-section">
          <legend>Media</legend>

          <label>
            Input Video Path
            <input
              placeholder="C:\Recordings\sermon.mp4"
              value={inputVideoPath}
              onChange={(e) => setInputVideoPath(e.currentTarget.value)}
              required
            />
          </label>

          <label>
            Leading Silence (seconds)
            <div className="silence-row">
              <input
                type="number"
                min={0}
                max={120}
                step={0.1}
                value={leadingSilenceSeconds}
                onChange={(e) =>
                  setLeadingSilenceSeconds(Number(e.currentTarget.value))
                }
              />
              <button
                type="button"
                className="btn-sm"
                onClick={detectSilence}
                disabled={detectingSilence || !inputVideoPath.trim()}
              >
                {detectingSilence ? "Detecting…" : "Auto-detect"}
              </button>
            </div>
          </label>
        </fieldset>

        {/* Publishing */}
        <fieldset className="form-section">
          <legend>Publishing</legend>

          <label>
            Custom Slug (optional)
            <input
              placeholder="auto-generated from date + title"
              value={slug}
              onChange={(e) => setSlug(e.currentTarget.value)}
            />
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={youtubeUploadEnabled}
              onChange={(e) => setYoutubeUploadEnabled(e.currentTarget.checked)}
            />
            Upload cleaned video to YouTube and patch markdown with youtubeID
          </label>
        </fieldset>

        <button type="submit" className="btn-publish" disabled={!canPublish || isPublishing}>
          {isPublishing ? "Planning…" : "Build Publish Plan"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {plan && (
        <section className="plan-card">
          <h2>Publish Plan</h2>
          <p className="plan-slug">{plan.slug}</p>
          <ol className="step-list">
            {plan.steps.map((step) => (
              <li key={step.id}>
                <span className="step-id">{step.id}</span>
                {step.description}
              </li>
            ))}
          </ol>
          <div className="plan-details">
            <p>
              <strong>Markdown:</strong> {plan.markdownPath}
            </p>
            <p>
              <strong>Website audio:</strong> {plan.websiteAudioPath}
            </p>
            <p>
              <strong>Thumbnail:</strong> {plan.thumbnailPath}
            </p>
            <p>
              <strong>YouTube video:</strong> {plan.cleanedVideoPath}
            </p>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
