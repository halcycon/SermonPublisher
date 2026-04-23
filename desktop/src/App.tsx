import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import "./App.css";

// ── Types ────────────────────────────────────────────────────────────────────

type Tab = "publish" | "sermons" | "settings" | "log";
type LogLevel = "debug" | "info" | "warn" | "error";

type LogEntry = {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
};

type NamedConfig = {
  id: string;
  name: string;
  owner: string;
  repo: string;
  branch: string;
  token: string;
};

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

type SermonEntry = {
  slug: string;
  title: string;
  speaker: string;
  date: string;
  series: string;
  scriptures: string[];
  summary: string;
  audio: string;
  image: string;
  youtubeId: string;
  draft: boolean;
  markdownPath: string;
};

type JivetalkingStatus = {
  available: boolean;
  method: string;
  message: string;
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
  draft: boolean;
  existingAudio: string;
};

type UpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseNotes: string;
};

type SavedSession = {
  title: string;
  speaker: string;
  date: string;
  series: string;
  scriptures: string[];
  summary: string;
  inputVideoPath: string;
  leadingSilenceSeconds: number;
  youtubeUploadEnabled: boolean;
  slug: string;
  isDraft: boolean;
  existingAudio: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const CONFIGS_STORAGE_KEY = "sermon-publisher-configs-v2";
const ACTIVE_CONFIG_STORAGE_KEY = "sermon-publisher-active-config-id";
const LOG_LEVEL_KEY = "sermon-publisher-log-level";
const OLD_GITHUB_KEY = "sermon-publisher-github";
const today = new Date().toISOString().slice(0, 10);
const CONTENT_DIR = "content/sermons";

function generateId(): string {
  return crypto.randomUUID();
}

function makeDefaultConfig(): NamedConfig {
  return { id: generateId(), name: "Default", owner: "", repo: "", branch: "main", token: "" };
}

function loadConfigs(): NamedConfig[] {
  try {
    const raw = localStorage.getItem(CONFIGS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as NamedConfig[];
    // Migrate from old single-config format.
    const oldRaw = localStorage.getItem(OLD_GITHUB_KEY);
    if (oldRaw) {
      const old = JSON.parse(oldRaw) as { owner?: string; repo?: string; branch?: string; token?: string };
      return [
        {
          id: "default",
          name: "Default",
          owner: old.owner ?? "",
          repo: old.repo ?? "",
          branch: old.branch ?? "main",
          token: old.token ?? "",
        },
      ];
    }
  } catch {
    /* ignore */
  }
  return [makeDefaultConfig()];
}

function loadActiveConfigId(configs: NamedConfig[]): string {
  try {
    const id = localStorage.getItem(ACTIVE_CONFIG_STORAGE_KEY);
    if (id && configs.some((c) => c.id === id)) return id;
  } catch {
    /* ignore */
  }
  return configs[0]?.id ?? "";
}

function loadLogLevel(): LogLevel {
  try {
    const val = localStorage.getItem(LOG_LEVEL_KEY);
    if (val === "debug" || val === "info" || val === "warn" || val === "error") return val;
  } catch {
    /* ignore */
  }
  return "info";
}

// ── Component ────────────────────────────────────────────────────────────────

function App() {
  // ── Navigation ───────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>("publish");

  // ── Configs ──────────────────────────────────────────────────────────────
  const [configs, setConfigs] = useState<NamedConfig[]>(loadConfigs);
  const [activeConfigId, setActiveConfigId] = useState<string>(() =>
    loadActiveConfigId(loadConfigs())
  );
  const [settingsSavedAt, setSettingsSavedAt] = useState<number>(0);

  const activeConfig = useMemo(
    () => configs.find((c) => c.id === activeConfigId) ?? configs[0] ?? makeDefaultConfig(),
    [configs, activeConfigId]
  );

  // ── Logging ──────────────────────────────────────────────────────────────
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logLevel, setLogLevel] = useState<LogLevel>(loadLogLevel);
  const [unreadLogs, setUnreadLogs] = useState(0);

  const addLog = useCallback(
    (level: LogLevel, message: string) => {
      const entry: LogEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        level,
        message,
      };
      setLogEntries((prev) => [...prev.slice(-999), entry]);
      setUnreadLogs((n) => n + 1);
    },
    []
  );

  // ── Series state ─────────────────────────────────────────────────────────
  const [seriesList, setSeriesList] = useState<SeriesInfo[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [newSeriesMode, setNewSeriesMode] = useState(false);
  const [seriesContentDirMissing, setSeriesContentDirMissing] = useState(false);

  // ── Speaker state ─────────────────────────────────────────────────────────
  const [speakersList, setSpeakersList] = useState<SpeakerInfo[]>([]);
  const [speakersLoading, setSpeakersLoading] = useState(false);
  const [newSpeakerMode, setNewSpeakerMode] = useState(false);

  // ── Scripture state ───────────────────────────────────────────────────────
  const [scriptures, setScriptures] = useState<string[]>([""]);

  // ── Silence detection ─────────────────────────────────────────────────────
  const [detectingSilence, setDetectingSilence] = useState(false);

  // ── Jivetalking ───────────────────────────────────────────────────────────
  const [jivetalkingStatus, setJivetalkingStatus] = useState<JivetalkingStatus | null>(null);

  // ── Form state ────────────────────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [date, setDate] = useState(today);
  const [series, setSeries] = useState("");
  const [summary, setSummary] = useState("");
  const [inputVideoPath, setInputVideoPath] = useState("");
  const [leadingSilenceSeconds, setLeadingSilenceSeconds] = useState(0);
  const [youtubeUploadEnabled, setYoutubeUploadEnabled] = useState(true);
  const [slug, setSlug] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [existingAudio, setExistingAudio] = useState("");

  // ── Publish output ────────────────────────────────────────────────────────
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [publishError, setPublishError] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);

  // ── Sermons list ──────────────────────────────────────────────────────────
  const [sermonsList, setSermonsList] = useState<SermonEntry[]>([]);
  const [sermonsLoading, setSermonsLoading] = useState(false);
  const [sermonsError, setSermonsError] = useState("");
  const [sermonsContentDirMissing, setSermonsContentDirMissing] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);

  // ── Update info ───────────────────────────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  // ── Persist configs ───────────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem(CONFIGS_STORAGE_KEY, JSON.stringify(configs));
  }, [configs]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_CONFIG_STORAGE_KEY, activeConfigId);
  }, [activeConfigId]);

  useEffect(() => {
    localStorage.setItem(LOG_LEVEL_KEY, logLevel);
  }, [logLevel]);

  // ── Initial checks ────────────────────────────────────────────────────────
  useEffect(() => {
    invoke<JivetalkingStatus>("check_jivetalking_status")
      .then((s) => {
        setJivetalkingStatus(s);
        addLog("info", `Jivetalking: ${s.message}`);
      })
      .catch(() => {/* ignore */});

    invoke<UpdateInfo>("check_for_updates")
      .then((info) => {
        setUpdateInfo(info);
        if (info.updateAvailable) {
          addLog("info", `Update available: v${info.latestVersion} (current: v${info.currentVersion})`);
        } else {
          addLog("debug", `App is up to date (v${info.currentVersion})`);
        }
      })
      .catch((e) => addLog("debug", `Update check skipped: ${String(e)}`));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Clear unread count when viewing log ───────────────────────────────────
  useEffect(() => {
    if (activeTab === "log") setUnreadLogs(0);
  }, [activeTab]);

  // ── Config helpers ────────────────────────────────────────────────────────

  const githubConfigured = useMemo(
    () =>
      !!(activeConfig.owner.trim() &&
      activeConfig.repo.trim() &&
      activeConfig.token.trim()),
    [activeConfig]
  );

  const updateConfigField = (cfgId: string, key: keyof NamedConfig, value: string) => {
    setConfigs((prev) =>
      prev.map((c) => (c.id === cfgId ? { ...c, [key]: value } : c))
    );
  };

  const addConfig = () => {
    const cfg = makeDefaultConfig();
    setConfigs((prev) => [...prev, cfg]);
    setActiveConfigId(cfg.id);
    setActiveTab("settings");
  };

  const removeConfig = (id: string) => {
    setConfigs((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (next.length === 0) next.push(makeDefaultConfig());
      return next;
    });
    if (activeConfigId === id) {
      const remaining = configs.filter((c) => c.id !== id);
      setActiveConfigId(remaining[0]?.id ?? "");
    }
  };

  const saveSettingsExplicitly = () => {
    localStorage.setItem(CONFIGS_STORAGE_KEY, JSON.stringify(configs));
    localStorage.setItem(ACTIVE_CONFIG_STORAGE_KEY, activeConfigId);
    setSettingsSavedAt(Date.now());
    addLog("info", "Settings saved.");
  };

  // ── Scripture helpers ─────────────────────────────────────────────────────

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

  // ── File picker ───────────────────────────────────────────────────────────

  const pickVideoFile = async () => {
    try {
      const file = await dialogOpen({
        multiple: false,
        filters: [
          { name: "Video", extensions: ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv"] },
        ],
      });
      if (typeof file === "string" && file) {
        setInputVideoPath(file);
        addLog("info", `Video selected: ${file}`);
      }
    } catch (e) {
      addLog("warn", `File picker error: ${String(e)}`);
    }
  };

  // ── Session save / load ───────────────────────────────────────────────────

  const saveSessionToFile = async () => {
    try {
      const filePath = await dialogSave({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: `${slug || "sermon"}-session.json`,
      });
      if (!filePath) return;
      const session: SavedSession = {
        title, speaker, date, series, scriptures, summary,
        inputVideoPath, leadingSilenceSeconds, youtubeUploadEnabled,
        slug, isDraft, existingAudio,
      };
      await invoke("save_settings_to_file", { path: filePath, content: JSON.stringify(session, null, 2) });
      addLog("info", `Session saved to ${filePath}`);
    } catch (e) {
      addLog("error", `Failed to save session: ${String(e)}`);
    }
  };

  const loadSessionFromFile = async () => {
    try {
      const filePath = await dialogOpen({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath || typeof filePath !== "string") return;
      const raw = await invoke<string>("load_settings_from_file", { path: filePath });
      const s = JSON.parse(raw) as Partial<SavedSession>;
      if (s.title !== undefined) setTitle(s.title);
      if (s.speaker !== undefined) setSpeaker(s.speaker);
      if (s.date !== undefined) setDate(s.date);
      if (s.series !== undefined) setSeries(s.series);
      if (Array.isArray(s.scriptures) && s.scriptures.length > 0) setScriptures(s.scriptures);
      if (s.summary !== undefined) setSummary(s.summary);
      if (s.inputVideoPath !== undefined) setInputVideoPath(s.inputVideoPath);
      if (s.leadingSilenceSeconds !== undefined) setLeadingSilenceSeconds(s.leadingSilenceSeconds);
      if (s.youtubeUploadEnabled !== undefined) setYoutubeUploadEnabled(s.youtubeUploadEnabled);
      if (s.slug !== undefined) setSlug(s.slug);
      if (s.isDraft !== undefined) setIsDraft(s.isDraft);
      if (s.existingAudio !== undefined) setExistingAudio(s.existingAudio);
      addLog("info", `Session loaded from ${filePath}`);
      setActiveTab("publish");
    } catch (e) {
      addLog("error", `Failed to load session: ${String(e)}`);
    }
  };

  // ── Series fetching ───────────────────────────────────────────────────────

  const fetchSeries = useCallback(async () => {
    if (!githubConfigured) return;
    setSeriesLoading(true);
    setPublishError("");
    setSeriesContentDirMissing(false);
    addLog("debug", `Fetching series from ${activeConfig.owner}/${activeConfig.repo}...`);
    try {
      const result = await invoke<SeriesInfo[]>("list_series", {
        githubOwner: activeConfig.owner,
        githubRepo: activeConfig.repo,
        githubBranch: activeConfig.branch || "main",
        githubToken: activeConfig.token,
        contentDir: CONTENT_DIR,
      });
      setSeriesList(result);
      if (result.length > 0 && !series) setSeries(result[0].name);
      setNewSeriesMode(result.length === 0);
      addLog("info", `Fetched ${result.length} series.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CONTENT_DIR_NOT_FOUND")) {
        setSeriesContentDirMissing(true);
        addLog("warn", `Sermon content directory not found: ${CONTENT_DIR}`);
      } else {
        setPublishError(`Failed to fetch series: ${msg}`);
        addLog("error", `Failed to fetch series: ${msg}`);
      }
    } finally {
      setSeriesLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfig, githubConfigured, series]);

  // ── Speaker fetching ──────────────────────────────────────────────────────

  const fetchSpeakers = useCallback(async () => {
    if (!githubConfigured) return;
    setSpeakersLoading(true);
    setPublishError("");
    addLog("debug", `Fetching speakers from ${activeConfig.owner}/${activeConfig.repo}...`);
    try {
      const result = await invoke<SpeakerInfo[]>("list_speakers", {
        githubOwner: activeConfig.owner,
        githubRepo: activeConfig.repo,
        githubBranch: activeConfig.branch || "main",
        githubToken: activeConfig.token,
        contentDir: CONTENT_DIR,
      });
      setSpeakersList(result);
      if (result.length > 0 && !speaker) setSpeaker(result[0].name);
      setNewSpeakerMode(result.length === 0);
      addLog("info", `Fetched ${result.length} speakers.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("CONTENT_DIR_NOT_FOUND")) {
        setPublishError(`Failed to fetch speakers: ${msg}`);
        addLog("error", `Failed to fetch speakers: ${msg}`);
      }
    } finally {
      setSpeakersLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfig, githubConfigured, speaker]);

  // ── Sermons list fetching ─────────────────────────────────────────────────

  const fetchSermons = useCallback(async () => {
    if (!githubConfigured) return;
    setSermonsLoading(true);
    setSermonsError("");
    setSermonsContentDirMissing(false);
    addLog("debug", `Fetching sermons from ${activeConfig.owner}/${activeConfig.repo}...`);
    try {
      const result = await invoke<SermonEntry[]>("list_sermons", {
        githubOwner: activeConfig.owner,
        githubRepo: activeConfig.repo,
        githubBranch: activeConfig.branch || "main",
        githubToken: activeConfig.token,
        contentDir: CONTENT_DIR,
      });
      setSermonsList(result);
      addLog("info", `Fetched ${result.length} sermons.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CONTENT_DIR_NOT_FOUND")) {
        setSermonsContentDirMissing(true);
        addLog("warn", "Sermon content directory not found in repo.");
      } else {
        setSermonsError(`Failed to fetch sermons: ${msg}`);
        addLog("error", `Failed to fetch sermons: ${msg}`);
      }
    } finally {
      setSermonsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfig, githubConfigured]);

  // ── Create content directory ──────────────────────────────────────────────

  const createContentDir = async () => {
    setCreatingDir(true);
    addLog("info", `Creating ${CONTENT_DIR} in ${activeConfig.owner}/${activeConfig.repo}...`);
    try {
      await invoke("create_content_directory", {
        githubOwner: activeConfig.owner,
        githubRepo: activeConfig.repo,
        githubBranch: activeConfig.branch || "main",
        githubToken: activeConfig.token,
        contentDir: CONTENT_DIR,
      });
      addLog("info", "Sermon content directory created successfully.");
      setSeriesContentDirMissing(false);
      setSermonsContentDirMissing(false);
      await fetchSermons();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog("error", `Failed to create directory: ${msg}`);
      setSermonsError(`Failed to create directory: ${msg}`);
    } finally {
      setCreatingDir(false);
    }
  };

  // ── Load sermon for editing ───────────────────────────────────────────────

  const loadSermonForEditing = (sermon: SermonEntry) => {
    setTitle(sermon.title);
    setSpeaker(sermon.speaker);
    setDate(sermon.date);
    setSeries(sermon.series);
    setScriptures(sermon.scriptures.length > 0 ? sermon.scriptures : [""]);
    setSummary(sermon.summary);
    setIsDraft(sermon.draft);
    setSlug(sermon.slug);
    setExistingAudio(sermon.audio);
    setInputVideoPath("");
    setPlan(null);
    setPublishError("");
    setActiveTab("publish");
    addLog("info", `Loaded "${sermon.title}" for editing.`);
  };

  // ── Silence detection ─────────────────────────────────────────────────────

  const detectSilence = useCallback(async () => {
    if (!inputVideoPath.trim()) {
      setPublishError("Enter a video path first");
      return;
    }
    setDetectingSilence(true);
    setPublishError("");
    addLog("debug", `Detecting silence in: ${inputVideoPath}`);
    try {
      const seconds = await invoke<number>("detect_leading_silence", { videoPath: inputVideoPath });
      setLeadingSilenceSeconds(seconds);
      addLog("info", `Detected ${seconds}s of leading silence.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPublishError(`Silence detection failed: ${msg}`);
      addLog("error", `Silence detection failed: ${msg}`);
    } finally {
      setDetectingSilence(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputVideoPath]);

  // ── Publish ───────────────────────────────────────────────────────────────

  async function onPublish(event: FormEvent) {
    event.preventDefault();
    setPublishError("");
    setIsPublishing(true);
    addLog("info", `Building publish plan for "${title}"...`);

    const request: PublishRequest = {
      title, speaker, date, series,
      scriptures: scriptures.filter((s) => s.trim()),
      summary, inputVideoPath,
      hugoContentDir: CONTENT_DIR,
      audioOutputDir: "static/audio/sermons",
      imageOutputDir: "static/images/sermons",
      slug: slug || undefined,
      leadingSilenceSeconds, youtubeUploadEnabled,
      githubOwner: activeConfig.owner,
      githubRepo: activeConfig.repo,
      githubBranch: activeConfig.branch || "main",
      draft: isDraft,
      existingAudio,
    };

    try {
      const nextPlan = await invoke<PublishPlan>("build_publish_plan", { request });
      setPlan(nextPlan);
      addLog("info", `Plan ready: ${nextPlan.steps.length} steps (slug: ${nextPlan.slug})`);
    } catch (err) {
      setPlan(null);
      const msg = err instanceof Error ? err.message : String(err);
      setPublishError(msg);
      addLog("error", `Publish plan failed: ${msg}`);
    } finally {
      setIsPublishing(false);
    }
  }

  const canPublish = useMemo(
    () =>
      !!(title.trim() &&
      (inputVideoPath.trim() || existingAudio.trim()) &&
      activeConfig.owner.trim() &&
      activeConfig.repo.trim()),
    [title, inputVideoPath, existingAudio, activeConfig.owner, activeConfig.repo]
  );

  // ── Log helpers ───────────────────────────────────────────────────────────

  const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  const filteredLog = useMemo(
    () => logEntries.filter((e) => levelOrder[e.level] >= levelOrder[logLevel]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logEntries, logLevel]
  );

  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeTab === "log") logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logEntries, activeTab]);

  // ── Shared create-dir notice ──────────────────────────────────────────────

  function renderCreateDirOffer() {
    return (
      <div className="notice notice--warn">
        <p>
          <strong>📂 Content directory not found.</strong> The sermon content directory
          (<code>{CONTENT_DIR}</code>) does not exist in this repository yet.
        </p>
        {githubConfigured ? (
          <button type="button" className="btn-sm" onClick={createContentDir} disabled={creatingDir}>
            {creatingDir ? "Creating..." : "Create Directory in Repo"}
          </button>
        ) : (
          <span className="small-hint">Configure GitHub settings first.</span>
        )}
      </div>
    );
  }

  // ── Publish Tab ───────────────────────────────────────────────────────────

  function renderPublishTab() {
    return (
      <>
        {githubConfigured ? (
          <div className="active-config-bar">
            <span className="active-config-label">
              <strong>{activeConfig.name}</strong>: {activeConfig.owner}/{activeConfig.repo} ({activeConfig.branch || "main"})
            </span>
            <button type="button" className="btn-sm btn-outline" onClick={() => setActiveTab("settings")}>
              Change
            </button>
          </div>
        ) : (
          <div className="notice notice--warn">
            GitHub settings are not configured.{" "}
            <button type="button" className="btn-sm" onClick={() => setActiveTab("settings")}>Configure</button>
          </div>
        )}

        {seriesContentDirMissing && renderCreateDirOffer()}

        <form className="publish-form" onSubmit={onPublish}>
          <fieldset className="form-section">
            <legend>Sermon Details</legend>

            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.currentTarget.value)} required />
            </label>

            <div className="row-2">
              <label>
                Speaker
                <div className="series-row">
                  {!newSpeakerMode ? (
                    <select value={speaker} onChange={(e) => setSpeaker(e.currentTarget.value)}>
                      <option value="">- select speaker -</option>
                      {speakersList.map((s) => (
                        <option key={s.name} value={s.name}>{s.name} ({s.sermonCount})</option>
                      ))}
                    </select>
                  ) : (
                    <input placeholder="Speaker name" value={speaker} onChange={(e) => setSpeaker(e.currentTarget.value)} />
                  )}
                  <button type="button" className="btn-sm" onClick={fetchSpeakers}
                    disabled={speakersLoading || !githubConfigured}
                    title={githubConfigured ? "Fetch speakers from site repo" : "Configure GitHub settings first"}>
                    {speakersLoading ? "Loading..." : "Fetch"}
                  </button>
                  <button type="button" className="btn-sm btn-outline"
                    onClick={() => { setNewSpeakerMode(!newSpeakerMode); if (!newSpeakerMode) setSpeaker(""); }}>
                    {newSpeakerMode ? "Existing" : "+ New"}
                  </button>
                </div>
              </label>
              <label>
                Date
                <input type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} />
              </label>
            </div>

            <label>
              Series
              <div className="series-row">
                {!newSeriesMode ? (
                  <select value={series} onChange={(e) => setSeries(e.currentTarget.value)}>
                    <option value="">- select series -</option>
                    {seriesList.map((s) => (
                      <option key={s.name} value={s.name}>{s.name} ({s.sermonCount})</option>
                    ))}
                  </select>
                ) : (
                  <input placeholder="New series name" value={series} onChange={(e) => setSeries(e.currentTarget.value)} />
                )}
                <button type="button" className="btn-sm" onClick={fetchSeries}
                  disabled={seriesLoading || !githubConfigured}
                  title={githubConfigured ? "Fetch series from site repo" : "Configure GitHub settings first"}>
                  {seriesLoading ? "Loading..." : "Fetch"}
                </button>
                <button type="button" className="btn-sm btn-outline"
                  onClick={() => { setNewSeriesMode(!newSeriesMode); if (!newSeriesMode) setSeries(""); }}>
                  {newSeriesMode ? "Existing" : "+ New"}
                </button>
              </div>
            </label>

            <div className="scripture-section">
              <span className="field-label">Scripture References</span>
              {scriptures.map((s, i) => (
                <div key={i} className="scripture-row">
                  <input placeholder="e.g. John 10:1-18" value={s}
                    onChange={(e) => updateScripture(i, e.currentTarget.value)} />
                  <button type="button" className="btn-icon" onClick={() => removeScripture(i)} title="Remove">x</button>
                </div>
              ))}
              <button type="button" className="btn-sm btn-outline add-scripture" onClick={addScripture}>
                + Add Reference
              </button>
            </div>

            <label>
              Summary
              <textarea rows={3} value={summary} onChange={(e) => setSummary(e.currentTarget.value)} />
            </label>
          </fieldset>

          <fieldset className="form-section">
            <legend>Media</legend>

            <label>
              Input Video File
              <div className="file-row">
                <input placeholder="Path to video file..." value={inputVideoPath}
                  onChange={(e) => setInputVideoPath(e.currentTarget.value)} />
                <button type="button" className="btn-sm" onClick={pickVideoFile}>Browse...</button>
              </div>
            </label>

            {existingAudio && (
              <div className="notice notice--info">
                <strong>Existing audio:</strong> {existingAudio}
                <span className="small-hint">
                  Leave the video blank to keep existing audio, or provide a new file to replace it.
                </span>
                <button type="button" className="btn-sm btn-outline" onClick={() => setExistingAudio("")}>
                  Clear
                </button>
              </div>
            )}

            <label>
              Leading Silence (seconds)
              <div className="silence-row">
                <input type="number" min={0} max={120} step={0.1} value={leadingSilenceSeconds}
                  onChange={(e) => setLeadingSilenceSeconds(Number(e.currentTarget.value))} />
                <button type="button" className="btn-sm" onClick={detectSilence}
                  disabled={detectingSilence || !inputVideoPath.trim()}>
                  {detectingSilence ? "Detecting..." : "Auto-detect"}
                </button>
              </div>
            </label>
          </fieldset>

          <fieldset className="form-section">
            <legend>Publishing Options</legend>

            <label>
              Custom Slug (optional)
              <input placeholder="auto-generated from date + title" value={slug}
                onChange={(e) => setSlug(e.currentTarget.value)} />
            </label>

            <label className="checkbox-row">
              <input type="checkbox" checked={youtubeUploadEnabled}
                onChange={(e) => setYoutubeUploadEnabled(e.currentTarget.checked)} />
              Upload cleaned video to YouTube and patch markdown with youtubeID
            </label>

            <label className="checkbox-row">
              <input type="checkbox" checked={isDraft}
                onChange={(e) => setIsDraft(e.currentTarget.checked)} />
              Save as draft
            </label>
          </fieldset>

          <div className="form-actions">
            <button type="submit" className="btn-publish" disabled={!canPublish || isPublishing}>
              {isPublishing ? "Planning..." : "Build Publish Plan"}
            </button>
            <button type="button" className="btn-sm btn-outline" onClick={saveSessionToFile}
              title="Save form to a JSON file">
              Save Session
            </button>
            <button type="button" className="btn-sm btn-outline" onClick={loadSessionFromFile}
              title="Load a saved session file">
              Load Session
            </button>
          </div>
        </form>

        {publishError && <p className="error">{publishError}</p>}

        {plan && (
          <section className="plan-card">
            <h2>
              Publish Plan
              {isDraft && <span className="draft-badge">DRAFT</span>}
            </h2>
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
              <p><strong>Markdown:</strong> {plan.markdownPath}</p>
              <p><strong>Website audio:</strong> {plan.websiteAudioPath}</p>
              <p><strong>Thumbnail:</strong> {plan.thumbnailPath}</p>
              <p><strong>YouTube video:</strong> {plan.cleanedVideoPath}</p>
            </div>
            <details className="markdown-preview">
              <summary>Preview Markdown</summary>
              <pre>{plan.markdown}</pre>
            </details>
          </section>
        )}
      </>
    );
  }

  // ── Sermons Tab ───────────────────────────────────────────────────────────

  function renderSermonsTab() {
    return (
      <div className="sermons-tab">
        <div className="tab-toolbar">
          <h2 className="tab-heading">Existing Sermons</h2>
          <button type="button" className="btn-sm" onClick={fetchSermons}
            disabled={sermonsLoading || !githubConfigured}
            title={githubConfigured ? "Fetch from repo" : "Configure GitHub settings first"}>
            {sermonsLoading ? "Loading..." : "Fetch Sermons"}
          </button>
        </div>

        {!githubConfigured && (
          <div className="notice notice--warn">
            Configure GitHub settings first.{" "}
            <button type="button" className="btn-sm" onClick={() => setActiveTab("settings")}>Settings</button>
          </div>
        )}

        {sermonsContentDirMissing && renderCreateDirOffer()}
        {sermonsError && <p className="error">{sermonsError}</p>}

        {sermonsList.length === 0 && !sermonsLoading && !sermonsContentDirMissing && githubConfigured && (
          <p className="empty-hint">No sermons loaded. Click "Fetch Sermons" to load from the repository.</p>
        )}

        {sermonsList.length > 0 && (
          <div className="sermons-list">
            {sermonsList.map((sermon) => (
              <div key={sermon.slug} className={`sermon-card${sermon.draft ? " sermon-card--draft" : ""}`}>
                <div className="sermon-card-header">
                  <div className="sermon-card-title">
                    <span className="sermon-title">{sermon.title || sermon.slug}</span>
                    {sermon.draft && <span className="draft-badge">DRAFT</span>}
                  </div>
                  <button type="button" className="btn-sm btn-outline"
                    onClick={() => loadSermonForEditing(sermon)}>
                    Edit
                  </button>
                </div>
                <div className="sermon-meta">
                  {sermon.date && <span>{sermon.date}</span>}
                  {sermon.speaker && <span> · {sermon.speaker}</span>}
                  {sermon.series && <span> · {sermon.series}</span>}
                </div>
                {sermon.summary && (
                  <p className="sermon-summary">
                    {sermon.summary.length > 140 ? sermon.summary.slice(0, 140) + "..." : sermon.summary}
                  </p>
                )}
                {sermon.audio && <p className="sermon-audio">{sermon.audio}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Settings Tab ──────────────────────────────────────────────────────────

  function renderSettingsTab() {
    const isSavedRecently = settingsSavedAt > 0 && Date.now() - settingsSavedAt < 3000;
    return (
      <div className="settings-tab">
        <div className="tab-toolbar">
          <h2 className="tab-heading">GitHub Configurations</h2>
          <div className="toolbar-actions">
            <button type="button" className="btn-sm btn-outline" onClick={addConfig}>
              + Add Config
            </button>
            <button type="button" className="btn-sm" onClick={saveSettingsExplicitly}>
              {isSavedRecently ? "Saved!" : "Save Settings"}
            </button>
          </div>
        </div>

        {configs.length > 1 && (
          <div className="config-selector">
            <label className="field-label">Active Configuration</label>
            <select value={activeConfigId} onChange={(e) => setActiveConfigId(e.currentTarget.value)}>
              {configs.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.owner}/{c.repo})</option>
              ))}
            </select>
          </div>
        )}

        {configs.map((cfg) => (
          <div key={cfg.id} className={`config-card${cfg.id === activeConfigId ? " config-card--active" : ""}`}>
            <div className="config-card-header">
              <span className="config-name">
                {cfg.id === activeConfigId ? "Active: " : ""}{cfg.name}
              </span>
              <div className="config-actions">
                {cfg.id !== activeConfigId && (
                  <button type="button" className="btn-sm btn-outline" onClick={() => setActiveConfigId(cfg.id)}>
                    Set Active
                  </button>
                )}
                {configs.length > 1 && (
                  <button type="button" className="btn-sm btn-danger" onClick={() => removeConfig(cfg.id)}>
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="config-fields">
              <label>
                Config Name
                <input value={cfg.name} placeholder="e.g. Main Church Site"
                  onChange={(e) => updateConfigField(cfg.id, "name", e.currentTarget.value)} />
              </label>
              <label>
                Repository Owner
                <input value={cfg.owner} placeholder="my-org"
                  onChange={(e) => updateConfigField(cfg.id, "owner", e.currentTarget.value)} />
              </label>
              <label>
                Repository Name
                <input value={cfg.repo} placeholder="church-website"
                  onChange={(e) => updateConfigField(cfg.id, "repo", e.currentTarget.value)} />
              </label>
              <label>
                Branch
                <input value={cfg.branch} placeholder="main"
                  onChange={(e) => updateConfigField(cfg.id, "branch", e.currentTarget.value)} />
              </label>
              <label className="span-full">
                Personal Access Token
                <input type="password" value={cfg.token} placeholder="ghp_..."
                  onChange={(e) => updateConfigField(cfg.id, "token", e.currentTarget.value)} />
              </label>
            </div>
          </div>
        ))}

        {jivetalkingStatus && !jivetalkingStatus.available && (
          <div className="notice notice--warn">
            {jivetalkingStatus.message}
          </div>
        )}
        {jivetalkingStatus?.method === "wsl" && (
          <div className="notice notice--ok">
            {jivetalkingStatus.message}
          </div>
        )}

        <div className="settings-footer">
          <button type="button" className="btn-sm" onClick={saveSettingsExplicitly}>
            {isSavedRecently ? "Saved!" : "Save Settings"}
          </button>
          <span className="small-hint">Settings also auto-save as you type.</span>
        </div>
      </div>
    );
  }

  // ── Log Tab ───────────────────────────────────────────────────────────────

  function renderLogTab() {
    return (
      <div className="log-tab">
        <div className="tab-toolbar">
          <h2 className="tab-heading">Application Log</h2>
          <div className="toolbar-actions">
            <label className="log-level-label">
              Min level:
              <select value={logLevel} onChange={(e) => setLogLevel(e.currentTarget.value as LogLevel)}>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </label>
            <button type="button" className="btn-sm btn-outline" onClick={() => setLogEntries([])}>
              Clear
            </button>
          </div>
        </div>

        <div className="log-list">
          {filteredLog.length === 0 && (
            <p className="empty-hint">No log entries at this level.</p>
          )}
          {filteredLog.map((entry) => (
            <div key={entry.id} className={`log-entry log-entry--${entry.level}`}>
              <span className="log-time">{entry.timestamp.slice(11, 19)}</span>
              <span className={`log-level-tag log-level-tag--${entry.level}`}>
                {entry.level.toUpperCase()}
              </span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="container">
      <header className="app-header">
        <h1 className="app-title">Sermon Publisher</h1>
        {updateInfo?.updateAvailable && (
          <a href={updateInfo.releaseUrl} target="_blank" rel="noreferrer" className="update-badge">
            Update available: v{updateInfo.latestVersion}
          </a>
        )}
      </header>

      <nav className="tab-nav">
        {(["publish", "sermons", "settings", "log"] as Tab[]).map((tab) => (
          <button key={tab} type="button"
            className={`tab-btn${activeTab === tab ? " tab-btn--active" : ""}`}
            onClick={() => setActiveTab(tab)}>
            {tab === "publish" && "Publish"}
            {tab === "sermons" && "Sermons"}
            {tab === "settings" && "Settings"}
            {tab === "log" && (
              <span className="tab-log-label">
                Log{unreadLogs > 0 && <span className="log-badge">{unreadLogs > 99 ? "99+" : unreadLogs}</span>}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="tab-content">
        {activeTab === "publish" && renderPublishTab()}
        {activeTab === "sermons" && renderSermonsTab()}
        {activeTab === "settings" && renderSettingsTab()}
        {activeTab === "log" && renderLogTab()}
      </div>
    </main>
  );
}

export default App;
