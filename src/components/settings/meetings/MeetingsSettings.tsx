import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Copy,
  FileText,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Mic,
  AlignLeft,
  Video,
  Keyboard,
  History,
} from "lucide-react";
import {
  commands,
  type ActiveMeeting,
  type MeetingDetail,
  type MeetingRow,
  type MeetingSearchHit,
  type MeetingSegment,
} from "@/bindings";
import {
  getDetectedCall,
  setDetectedCall,
  subscribeDetectedCall,
} from "../../../lib/meetingDetect";
import { useSettings } from "../../../hooks/useSettings";
import { ShortcutInput } from "../ShortcutInput";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Button } from "../../ui/Button";
import { Alert } from "../../ui/Alert";
import Badge from "../../ui/Badge";
import { Input } from "../../ui/Input";
import { SummaryTemplates } from "./SummaryTemplates";
import { copyToClipboard } from "../history/clipboard";
import {
  buildMarkdown,
  buildTranscript,
  formatClock,
  parseSummary,
  type SummaryData,
} from "./meetingFormat";

const formatDuration = (startedAt: number, endedAt: number | null) => {
  if (!endedAt) return "";
  return formatClock(Math.max(0, endedAt - startedAt) * 1000);
};

const speakerKey = (track: string) =>
  track === "you" ? "meetings.you" : "meetings.others";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Snippet text with the searched words wrapped in <mark>. */
const Highlighted: React.FC<{ text: string; query: string }> = ({
  text,
  query,
}) => {
  const words = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return <>{text}</>;
  const re = new RegExp(`(${words.join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-logo-primary/30 px-0.5 text-text">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
};

const matchFieldKey = (field: string) =>
  field === "title"
    ? "meetings.matchTitle"
    : field === "summary"
      ? "meetings.matchSummary"
      : "meetings.matchTranscript";

const SegmentList: React.FC<{ segments: MeetingSegment[] }> = ({
  segments,
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      {segments.map((s, i) => (
        <div key={`${s.start_ms}-${i}`} className="flex gap-3 text-sm">
          <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-text/40">
            {formatClock(s.start_ms)}
          </span>
          <div className="min-w-0">
            <span
              className={`me-2 text-xs font-semibold ${
                s.track === "you" ? "text-logo-primary" : "text-text/60"
              }`}
            >
              {t(speakerKey(s.track))}
            </span>
            <span className="text-text/90">{s.text}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

const Section: React.FC<{ title: string; items?: string[] }> = ({
  title,
  items,
}) =>
  items && items.length > 0 ? (
    <div className="space-y-1">
      <h4 className="text-sm font-semibold text-text">{title}</h4>
      <ul className="list-disc space-y-0.5 ps-5 text-sm text-text/80">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  ) : null;

const SummaryView: React.FC<{ data: SummaryData }> = ({ data }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {data.summary && (
        <p className="text-sm leading-relaxed text-text/90">{data.summary}</p>
      )}
      <Section title={t("meetings.keyPoints")} items={data.keyPoints} />
      <Section title={t("meetings.decisions")} items={data.decisions} />
      {data.actionItems && data.actionItems.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-text">
            {t("meetings.actionItems")}
          </h4>
          <ul className="space-y-1 text-sm text-text/80">
            {data.actionItems.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden>{"\u2610"}</span>
                <span>
                  {a.task}
                  {(a.owner || a.due) && (
                    <span className="text-text/50">
                      {" "}
                      ({[a.owner, a.due].filter(Boolean).join(", ")})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Section title={t("meetings.openQuestions")} items={data.openQuestions} />
    </div>
  );
};

const summaryProblemKey = (code: string): string => {
  switch (code) {
    case "no_provider":
    case "no_model":
      return "meetings.summaryNeedsModel";
    case "apple_unsupported":
      return "meetings.summaryAppleUnsupported";
    case "no_transcript":
      return "meetings.summaryNoTranscript";
    default:
      return "meetings.summaryFailed";
  }
};

const MeetingDetailView: React.FC<{
  id: number;
  onBack: () => void;
  onChanged: () => void;
  summaryProblem: string | null;
  clearProblem: () => void;
}> = ({ id, onBack, onChanged, summaryProblem, clearProblem }) => {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [title, setTitle] = useState("");
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    const res = await commands.meetingGet(id);
    if (res.status === "ok" && res.data) {
      setDetail(res.data);
      setTitle(res.data.title);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unlisten = listen<{ meeting_id: number; ok: boolean }>(
      "meeting-summary",
      (event) => {
        if (event.payload.meeting_id === id) {
          setWorking(false);
          void load();
          onChanged();
        }
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [id, load, onChanged]);

  if (!detail) {
    return (
      <div className="p-4 text-sm text-text/60">{t("common.loading")}</div>
    );
  }

  const summary = parseSummary(detail.summary);
  const labels = {
    you: t("meetings.you"),
    others: t("meetings.others"),
    summary: t("meetings.summary"),
    keyPoints: t("meetings.keyPoints"),
    decisions: t("meetings.decisions"),
    actionItems: t("meetings.actionItems"),
    openQuestions: t("meetings.openQuestions"),
    transcript: t("meetings.transcript"),
  };

  const rename = async () => {
    const next = title.trim();
    if (!next || next === detail.title) {
      setTitle(detail.title);
      return;
    }
    await commands.meetingRename(id, next);
    void load();
    onChanged();
  };

  const regenerate = async () => {
    clearProblem();
    setWorking(true);
    await commands.meetingSummarize(id);
  };

  const saveDocument = async (kind: "docx" | "pdf") => {
    if (!detail) return;
    try {
      const { buildExportDoc, buildDocx, buildPdf } = await import(
        "./meetingExport"
      );
      const doc = buildExportDoc(detail, summary, labels);
      const bytes =
        kind === "docx" ? await buildDocx(doc) : await buildPdf(doc);
      const date = new Date(detail.started_at * 1000)
        .toISOString()
        .slice(0, 10);
      const res = await commands.meetingSaveDocument(
        detail.title,
        date,
        kind,
        Array.from(bytes),
      );
      if (res.status !== "ok") throw new Error(res.error);
      toast.success(t("meetings.saved"));
      try {
        await revealItemInDir(res.data);
      } catch {
        // Saving worked; only showing the folder failed.
      }
    } catch {
      toast.error(t("meetings.saveFailed"));
    }
  };

  const copy = async (text: string) => {
    if (await copyToClipboard(text)) toast.success(t("meetings.copied"));
  };

  const remove = async () => {
    if (!window.confirm(t("meetings.confirmDelete"))) return;
    const res = await commands.meetingDelete(id);
    if (res.status === "ok") {
      onChanged();
      onBack();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <span className="flex items-center gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            {t("meetings.back")}
          </span>
        </Button>
      </div>

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="text-lg font-semibold"
      />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void copy(buildMarkdown(detail, summary, labels))}
        >
          <span className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            {t("meetings.copyNotes")}
          </span>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void saveDocument("docx")}
        >
          <span className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            {t("meetings.saveWord")}
          </span>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void saveDocument("pdf")}
        >
          <span className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            {t("meetings.savePdf")}
          </span>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void copy(buildTranscript(detail, labels))}
        >
          <span className="flex items-center gap-1.5">
            <Copy className="h-3.5 w-3.5" />
            {t("meetings.copyTranscript")}
          </span>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={working || detail.segments.length === 0}
          onClick={() => void regenerate()}
        >
          <span className="flex items-center gap-1.5">
            {working ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {summary ? t("meetings.regenerate") : t("meetings.makeSummary")}
          </span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto text-logo-primary/85 hover:bg-logo-primary/10 hover:text-logo-primary"
          onClick={() => void remove()}
        >
          <span className="flex items-center gap-1.5">
            <Trash2 className="h-3.5 w-3.5" />
            {t("common.delete")}
          </span>
        </Button>
      </div>

      <SettingsGroup title={t("meetings.summary")} icon={<FileText />}>
        <div className="space-y-3 px-4 py-3">
          {summary ? (
            <SummaryView data={summary} />
          ) : working ? (
            <div className="flex items-center gap-2 text-sm text-text/60">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("meetings.summarising")}
            </div>
          ) : (
            <Alert variant={summaryProblem ? "warning" : "info"} contained>
              {summaryProblem
                ? t(summaryProblemKey(summaryProblem))
                : t("meetings.noSummaryYet")}
            </Alert>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("meetings.transcript")} icon={<AlignLeft />}>
        <div className="px-4 py-3">
          {detail.segments.length === 0 ? (
            <p className="text-sm text-text/60">
              {t("meetings.emptyTranscript")}
            </p>
          ) : (
            <SegmentList segments={detail.segments} />
          )}
        </div>
      </SettingsGroup>
    </div>
  );
};

const LevelBar: React.FC<{ label: string; value: number; dim?: boolean }> = ({
  label,
  value,
  dim,
}) => (
  <div className={`space-y-1 ${dim ? "opacity-40" : ""}`}>
    <div className="text-xs text-text/60">{label}</div>
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-mid-gray/20">
      <div
        className="h-full rounded-full bg-logo-primary transition-[width] duration-200"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  </div>
);

export const MeetingsSettings: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting, isUpdating } = useSettings();
  const [active, setActive] = useState<ActiveMeeting | null>(null);
  const [rows, setRows] = useState<MeetingRow[]>([]);
  const [live, setLive] = useState<MeetingSegment[]>([]);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MeetingSearchHit[] | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [levels, setLevels] = useState({ you: 0, others: 0 });
  const [selected, setSelected] = useState<number | null>(null);
  const [summaryProblem, setSummaryProblem] = useState<string | null>(null);
  const liveEnd = useRef<HTMLDivElement | null>(null);

  const loadRows = useCallback(async () => {
    const res = await commands.meetingList();
    if (res.status === "ok") setRows(res.data);
  }, []);

  // Search all meetings (title, summary, transcript) shortly after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void commands.meetingSearch(q).then((res) => {
        if (!stale) setHits(res.status === "ok" ? res.data : []);
      });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const loadActive = useCallback(async () => {
    const res = await commands.meetingActive();
    if (res.status === "ok") setActive(res.data);
  }, []);

  useEffect(() => {
    void loadRows();
    void loadActive();
  }, [loadRows, loadActive]);

  useEffect(() => {
    const subs = [
      listen<{
        meeting_id: number;
        track: string;
        start_ms: number;
        text: string;
      }>("meeting-segment", (event) => {
        const p = event.payload;
        setLive((prev) => [
          ...prev,
          { track: p.track, start_ms: p.start_ms, text: p.text },
        ]);
      }),
      listen<{ meeting_id: number; message: string }>("meeting-error", (e) => {
        if (e.payload.message === "no_speech") {
          toast.warning(t("meetings.noSpeech"));
          return;
        }
        if (e.payload.message === "too_slow") {
          toast.warning(t("meetings.tooSlow"), { duration: 15000 });
          return;
        }
        if (e.payload.message === "stopped_early") {
          toast.warning(t("meetings.stoppedEarly"), { duration: 15000 });
          return;
        }
        toast.error(t("meetings.transcribeError"), {
          description: e.payload.message,
        });
      }),
      listen<{ you: number; others: number; paused: boolean }>(
        "meeting-levels",
        (e) => setLevels({ you: e.payload.you, others: e.payload.others }),
      ),
      listen<boolean>("meeting-paused", (e) =>
        setActive((prev) => (prev ? { ...prev, paused: e.payload } : prev)),
      ),
      listen<{ meeting_id: number; ok: boolean; message: string }>(
        "meeting-summary",
        (e) => {
          setSummaryProblem(e.payload.ok ? null : e.payload.message);
          void loadRows();
        },
      ),
    ];
    return () => {
      subs.forEach((s) => void s.then((fn) => fn()));
    };
  }, [t, loadRows]);

  const pausedNow = active?.paused ?? false;
  const hasActive = active !== null;
  const startedAt = active?.started_at ?? 0;
  useEffect(() => {
    if (!hasActive) return;
    setElapsed(Math.max(0, Math.floor(Date.now() / 1000) - startedAt));
    const timer = setInterval(() => {
      if (!pausedNow) setElapsed((e) => e + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [hasActive, startedAt, pausedNow]);

  // Started or stopped elsewhere (keyboard shortcut, tray menu).
  useEffect(() => {
    const unlisten = listen<boolean>("meeting-status", async (event) => {
      if (event.payload) {
        const res = await commands.meetingActive();
        if (res.status === "ok" && res.data) {
          setActive(res.data);
          setLive([]);
          setSelected(null);
          setDetectedCall(null);
        }
      } else {
        setActive(null);
        void loadRows();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadRows]);

  const detectedCall = useSyncExternalStore(
    subscribeDetectedCall,
    getDetectedCall,
  );

  useEffect(() => {
    liveEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [live]);

  const start = async () => {
    setBusy(true);
    setLive([]);
    setSummaryProblem(null);
    try {
      const res = await commands.meetingStart(title.trim() || null);
      if (res.status === "ok") {
        setActive(res.data);
        setTitle("");
        void loadRows();
      } else if (res.error === "no_model") {
        toast.error(t("meetings.needModel"));
      } else {
        toast.error(t("meetings.startFailed"), { description: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const res = await commands.meetingStop();
      setActive(null);
      void loadRows();
      if (res.status === "ok") setSelected(res.data);
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    if (!active) return;
    const res = active.paused
      ? await commands.meetingResume()
      : await commands.meetingPause();
    if (res.status === "error") toast.error(res.error);
  };

  const warningText = (() => {
    const w = active?.warning;
    if (!w) return null;
    if (w.startsWith("system_audio_unavailable"))
      return t("meetings.warnSystemAudio");
    if (w.startsWith("microphone_unavailable")) return t("meetings.warnMic");
    return w;
  })();

  if (selected !== null && !active) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <MeetingDetailView
          key={selected}
          id={selected}
          onBack={() => {
            setSelected(null);
            void loadRows();
          }}
          onChanged={() => void loadRows()}
          summaryProblem={summaryProblem}
          clearProblem={() => setSummaryProblem(null)}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <SettingsGroup title={t("meetings.title")} icon={<Video />}>
        <div className="space-y-3 px-4 py-3">
          <p className="text-sm text-text/70">{t("meetings.intro")}</p>

          {!active && detectedCall && (
            <Alert variant="info" contained>
              <div className="flex flex-wrap items-center gap-3">
                <span>{t("meetings.detected", { app: detectedCall })}</span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setDetectedCall(null);
                    void start();
                  }}
                >
                  {t("meetings.detectedYes")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDetectedCall(null)}
                >
                  {t("meetings.detectedNo")}
                </Button>
              </div>
            </Alert>
          )}
          {active ? (
            <>
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3">
                  {!active.paused && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
                  )}
                  <span
                    className={`relative inline-flex h-3 w-3 rounded-full ${active.paused ? "bg-amber-500" : "bg-red-500"}`}
                  />
                </span>
                <span className="text-sm font-semibold tabular-nums text-text">
                  {formatClock(elapsed * 1000)}
                </span>
                <span className="text-sm text-text/60">
                  {active.paused
                    ? t("meetings.paused")
                    : t("meetings.recording")}
                </span>
                <div className="ms-auto flex gap-2">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void togglePause()}
                  >
                    <span className="flex items-center gap-1.5">
                      {active.paused ? (
                        <Play className="h-4 w-4" />
                      ) : (
                        <Pause className="h-4 w-4" />
                      )}
                      {active.paused
                        ? t("meetings.resume")
                        : t("meetings.pause")}
                    </span>
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => void stop()}
                  >
                    <span className="flex items-center gap-1.5">
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                      {busy ? t("meetings.finishing") : t("meetings.stop")}
                    </span>
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <LevelBar label={t("meetings.levelYou")} value={levels.you} />
                <LevelBar
                  label={t("meetings.levelOthers")}
                  value={levels.others}
                  dim={!active.system_audio}
                />
              </div>
              {warningText && (
                <Alert variant="warning" contained>
                  {warningText}
                </Alert>
              )}
              <div className="max-h-72 min-h-24 overflow-y-auto rounded-lg bg-mid-gray/10 p-3">
                {live.length === 0 ? (
                  <p className="text-sm text-text/50">
                    {t("meetings.waitingForSpeech")}
                  </p>
                ) : (
                  <SegmentList segments={live} />
                )}
                <div ref={liveEnd} />
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-2">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("meetings.titlePlaceholder")}
                  className="flex-1"
                />
                <Button disabled={busy} onClick={() => void start()}>
                  <span className="flex items-center gap-1.5">
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                    {t("meetings.start")}
                  </span>
                </Button>
              </div>
              <p className="text-xs text-text/50">{t("meetings.consent")}</p>
              <p className="text-xs text-text/50">
                {t("meetings.tipHeadphones")}
              </p>
            </>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("meetings.shortcutTitle")} icon={<Keyboard />}>
        <ShortcutInput shortcutId="meeting_toggle" grouped={true} />
        <ToggleSwitch
          checked={settings?.meeting_prompt_enabled ?? true}
          onChange={(value) => updateSetting("meeting_prompt_enabled", value)}
          isUpdating={isUpdating("meeting_prompt_enabled")}
          label={t("meetings.promptLabel")}
          description={t("meetings.promptDescription")}
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>
      <SummaryTemplates />
      <p className="px-1 text-xs text-text/60">{t("meetings.storageNote")}</p>
      <label className="flex items-center justify-between gap-3 px-1 text-sm">
        <span>{t("meetings.retention.label")}</span>
        <select
          value={String(settings?.meeting_retention_days ?? 0)}
          onChange={(e) =>
            void updateSetting("meeting_retention_days", Number(e.target.value))
          }
          className="rounded-lg border border-mid-gray/40 bg-transparent px-2 py-1"
        >
          {[0, 30, 90, 365].map((d) => (
            <option key={d} value={d}>
              {d === 0
                ? t("meetings.retention.never")
                : t("meetings.retention.days", { count: d })}
            </option>
          ))}
        </select>
      </label>
      <SettingsGroup title={t("meetings.pastTitle")} icon={<History />}>
        {rows.length > 0 && (
          <div className="px-4 pt-3">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("meetings.searchPlaceholder")}
              aria-label={t("meetings.search")}
            />
          </div>
        )}
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-text/60">{t("meetings.none")}</p>
        ) : query.trim() ? (
          hits === null ? null : hits.length === 0 ? (
            <p className="px-4 py-3 text-sm text-text/60">
              {t("meetings.noResults")}
            </p>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                disabled={active?.id === hit.id}
                onClick={() => setSelected(hit.id)}
                className="flex w-full flex-col gap-1 px-4 py-3 text-start transition-colors hover:bg-mid-gray/10 disabled:cursor-default disabled:opacity-60"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                    {hit.title}
                  </span>
                  <Badge variant="secondary">
                    {t(matchFieldKey(hit.field))}
                    {hit.start_ms !== null
                      ? ` ${formatClock(hit.start_ms)}`
                      : ""}
                  </Badge>
                </div>
                <div className="text-xs text-text/50">
                  {new Date(hit.started_at * 1000).toLocaleString()}
                </div>
                <p className="text-sm text-text/80">
                  <Highlighted text={hit.snippet} query={query} />
                </p>
              </button>
            ))
          )
        ) : (
          rows.map((row) => (
            <button
              key={row.id}
              type="button"
              disabled={active?.id === row.id}
              onClick={() => setSelected(row.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-mid-gray/10 disabled:cursor-default disabled:opacity-60"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text">
                  {row.title}
                </div>
                <div className="text-xs text-text/50">
                  {new Date(row.started_at * 1000).toLocaleString()}
                  {row.ended_at
                    ? ` \u00b7 ${formatDuration(row.started_at, row.ended_at)}`
                    : ""}
                </div>
              </div>
              {row.has_summary && (
                <Badge variant="success">{t("meetings.summaryReady")}</Badge>
              )}
            </button>
          ))
        )}
      </SettingsGroup>
    </div>
  );
};
