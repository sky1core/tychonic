import {
  Activity,
  Archive,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Inbox,
  RadioTower,
  RefreshCw,
  Search,
  Send,
  UserRoundCog
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

type WorkflowSummary = {
  workflowId: string;
  runId?: string;
  type?: string;
  taskQueue?: string;
  status?: string;
  historyLength?: number;
  startTime?: string;
  closeTime?: string;
};

type WorkflowStep = {
  id: string;
  name: string;
  status: string;
  reason?: string;
  activity_attempt_ids?: string[];
  artifact_ids?: string[];
  finding_ids?: string[];
};

type InboxItem = {
  id: string;
  status: string;
  title?: string;
  detail?: string;
  action?: { kind?: string; reason?: string };
};

type SessionItem = {
  id: string;
  agent: string;
  role: string;
  status: string;
  cwd?: string;
  external_session_id?: string;
  resume_command?: string;
};

type ArtifactItem = {
  id: string;
  kind: string;
  path: string;
};

type AttemptItem = {
  id: string;
  type: string;
  status: string;
  live_output_path?: string;
};

type CatalogResponse = {
  ok: boolean;
  counts?: {
    profile_files?: number;
    valid_profiles?: number;
    invalid_profiles?: number;
  };
  sources?: Array<{ source: string; path: string }>;
};

type RunsResponse = {
  ok: boolean;
  workflows?: WorkflowSummary[];
};

type WorkflowResponse = {
  ok: boolean;
  workflow?: WorkflowSummary & {
    pendingActivities?: unknown[];
    result?: {
      run?: {
        status?: string;
        goal?: string;
        steps?: WorkflowStep[];
      };
    };
  };
};

const defaultVerifyCommand = "npm run typecheck && npm test && npm run build";

export function App() {
  const [catalog, setCatalog] = useState<CatalogResponse>({ ok: false });
  const [runs, setRuns] = useState<WorkflowSummary[]>([]);
  const [runFilter, setRunFilter] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowResponse["workflow"]>();
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [attempts, setAttempts] = useState<AttemptItem[]>([]);
  const [preview, setPreview] = useState("Choose an artifact or live log.");
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const inboxFormRef = useRef<HTMLFormElement>(null);

  const steps = workflow?.result?.run?.steps ?? [];
  const openInbox = inbox.filter((item) => item.status === "open");
  const failedSteps = steps.filter((step) => ["failed", "blocked", "timed_out"].includes(step.status));
  const runStatus = workflow?.result?.run?.status ?? workflow?.status ?? "idle";
  const selectedRun = runs.find((run) => run.workflowId === selectedWorkflowId);
  const selectedType = selectedRun?.type ?? workflow?.type ?? "workflow";
  const pendingActivities = workflow?.pendingActivities?.length ?? 0;

  const filteredRuns = useMemo(() => {
    const filter = runFilter.trim().toLowerCase();
    if (!filter) {
      return runs;
    }
    return runs.filter((run) =>
      [run.workflowId, run.runId, run.type, run.status, run.taskQueue]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(filter))
    );
  }, [runFilter, runs]);

  const requiredAction = actionForRun({
    failedSteps,
    loading,
    openInbox,
    selectedWorkflowId
  });

  useEffect(() => {
    void refreshCatalog();
    void refreshRuns();
  }, []);

  async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, init);
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok || body.ok === false) {
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    return body as T;
  }

  function log(message: string, payload?: unknown) {
    const suffix = payload === undefined ? "" : ` ${JSON.stringify(payload)}`;
    setEvents((current) => [`${new Date().toLocaleTimeString()} ${message}${suffix}`, ...current].slice(0, 24));
  }

  async function refreshCatalog() {
    try {
      const body = await requestJSON<CatalogResponse>("/workflows");
      setCatalog(body);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshRuns() {
    try {
      const body = await requestJSON<RunsResponse>("/runs?limit=30");
      const nextRuns = body.workflows ?? [];
      setRuns(nextRuns);
      const firstWorkflowId = nextRuns[0]?.workflowId;
      if (!selectedWorkflowId && firstWorkflowId) {
        await selectWorkflow(firstWorkflowId);
      }
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectWorkflow(workflowId: string) {
    setLoading(true);
    setSelectedWorkflowId(workflowId);
    try {
      const selected = await requestJSON<WorkflowResponse>(`/runs/${encodeURIComponent(workflowId)}?result=1`);
      setWorkflow(selected.workflow);
      const [inboxBody, sessionBody, artifactBody, logBody] = await Promise.all([
        requestJSON<{ inbox?: InboxItem[] }>(`/inbox?workflow_id=${encodeURIComponent(workflowId)}`),
        requestJSON<{ sessions?: SessionItem[] }>(`/sessions?workflow_id=${encodeURIComponent(workflowId)}`),
        requestJSON<{ artifacts?: ArtifactItem[] }>(`/artifact?workflow_id=${encodeURIComponent(workflowId)}`),
        requestJSON<{ attempts?: AttemptItem[] }>(`/log?workflow_id=${encodeURIComponent(workflowId)}`)
      ]);
      setInbox(inboxBody.inbox ?? []);
      setSessions(sessionBody.sessions ?? []);
      setArtifacts(artifactBody.artifacts ?? []);
      setAttempts(logBody.attempts ?? []);
      setPreview("Choose an artifact or live log.");
      log("Loaded workflow", { workflowId });
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function previewText(path: string) {
    try {
      const response = await fetch(path);
      const body = await response.text();
      if (!response.ok) {
        throw new Error(body);
      }
      setPreview(body ? body : "(empty)");
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }

  async function executeInbox(itemId: string) {
    try {
      const form = inboxFormRef.current;
      const values = form ? new FormData(form) : new FormData();
      const payload: Record<string, unknown> = {
        workflow_id: selectedWorkflowId,
        inbox_item_id: itemId,
        verify_command: formString(values, "verify_command", defaultVerifyCommand)
      };
      addString(payload, values, "command");
      addString(payload, values, "agent");
      addString(payload, values, "goal");
      addString(payload, values, "resume_command");
      addString(payload, values, "review_command");
      addString(payload, values, "review_agent");
      addNumber(payload, values, "command_timeout_ms");
      addJSON(payload, values, "worker_candidates");
      addJSON(payload, values, "review_candidates");

      const body = await requestJSON("/inbox/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      log("Sent inbox continuation signal", body);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }

  async function dismissInbox(itemId: string) {
    try {
      const form = inboxFormRef.current;
      const values = form ? new FormData(form) : new FormData();
      const body = await requestJSON("/inbox/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflow_id: selectedWorkflowId,
          inbox_item_id: itemId,
          reason: formString(values, "dismiss_reason")
        })
      });
      log("Sent inbox dismiss signal", body);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }

  async function registerSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const values = new FormData(event.currentTarget);
      const body = await requestJSON("/sessions/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflow_id: selectedWorkflowId,
          id: formString(values, "session_id"),
          agent: formString(values, "agent", "codex"),
          role: "worker",
          cwd: formString(values, "session_cwd"),
          status: "running",
          resume_command: formString(values, "resume_command")
        })
      });
      log("Sent register signal", body);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }

  async function resumeSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const values = new FormData(event.currentTarget);
      const body = await requestJSON("/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflow_id: selectedWorkflowId,
          session_id: formString(values, "session_id"),
          prompt: formString(values, "prompt"),
          verify_command: formString(values, "verify_command", defaultVerifyCommand)
        })
      });
      log("Sent resume signal", body);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="workbench-shell">
      <header className="topbar">
        <div className="product-lockup">
          <span className="brand-mark">Ty</span>
          <div>
            <p className="eyebrow">Temporal delegation manager</p>
            <h1>Tychonic</h1>
          </div>
        </div>
        <div className="topbar-status" aria-label="Workflow catalog status">
          <InlineMetric label="Profiles" value={catalog.counts?.profile_files ?? 0} />
          <InlineMetric label="Valid" value={catalog.counts?.valid_profiles ?? 0} />
          <InlineMetric label="Invalid" value={catalog.counts?.invalid_profiles ?? 0} tone="danger" />
        </div>
        <div className="topbar-actions">
          <button onClick={() => void refreshCatalog()} type="button">
            <RefreshCw size={16} /> Catalog
          </button>
          <button className="primary-action" onClick={() => void refreshRuns()} type="button">
            <RadioTower size={16} /> Refresh runs
          </button>
        </div>
      </header>

      <main className="workbench" aria-label="Tychonic workbench">
        <aside className="run-queue" aria-label="Run queue">
          <div className="pane-title">
            <div>
              <p className="eyebrow">Run queue</p>
              <h2>Temporal runs</h2>
            </div>
            <span className="count-chip">{filteredRuns.length}/{runs.length}</span>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              onChange={(event) => setRunFilter(event.target.value)}
              placeholder="Filter workflow, status, queue"
              value={runFilter}
            />
          </label>
          <div className="queue-list">
            {filteredRuns.length === 0 ? <EmptyLine text="No runs match this filter." /> : null}
            {filteredRuns.map((run) => (
              <button
                className={run.workflowId === selectedWorkflowId ? "queue-row active" : "queue-row"}
                key={run.workflowId}
                onClick={() => void selectWorkflow(run.workflowId)}
                type="button"
              >
                <span className="queue-row-main">
                  <strong>{run.workflowId}</strong>
                  <small>{run.type ?? "workflow"} · {run.taskQueue ?? "tychonic"}</small>
                </span>
                <StatusBadge status={run.status ?? "unknown"} />
              </button>
            ))}
          </div>
        </aside>

        <section className="run-workspace" aria-label="Selected run">
          <div className="selected-run-header">
            <div>
              <p className="eyebrow">Selected run</p>
              <h2>{selectedWorkflowId || "Select a workflow run"}</h2>
            </div>
            <StatusBadge status={runStatus} />
          </div>

          <div className="run-summary">
            <InlineMetric label="Type" value={selectedType} />
            <InlineMetric label="History" value={selectedRun?.historyLength ?? workflow?.historyLength ?? "-"} />
            <InlineMetric label="Pending" value={pendingActivities} tone={pendingActivities > 0 ? "attention" : "neutral"} />
            <InlineMetric label="Open review" value={openInbox.length} tone={openInbox.length > 0 ? "attention" : "neutral"} />
          </div>

          <section className={`required-action ${requiredAction.tone}`}>
            <div className="action-icon">{requiredAction.icon}</div>
            <div>
              <p className="eyebrow">Required action</p>
              <h3>{requiredAction.title}</h3>
              <p>{requiredAction.body}</p>
            </div>
          </section>

          <section className="loop-panel">
            <div className="pane-title compact">
              <div>
                <p className="eyebrow">Work review loop</p>
                <h3>Timeline</h3>
              </div>
              <span className="count-chip">{steps.length} steps</span>
            </div>
            <div className="timeline">
              {steps.length === 0 ? <EmptyLine text="No step detail for this run." /> : null}
              {steps.map((step, index) => (
                <article className="timeline-row" key={step.id}>
                  <div className="timeline-marker">
                    <StatusDot status={step.status} />
                    {index < steps.length - 1 ? <span /> : null}
                  </div>
                  <div className="timeline-body">
                    <div className="row-title">
                      <strong>{step.name}</strong>
                      <StatusBadge status={step.status} />
                    </div>
                    <p>{step.reason ?? "No reason recorded."}</p>
                    <small>
                      {(step.activity_attempt_ids?.length ?? 0)} attempts · {(step.artifact_ids?.length ?? 0)} artifacts ·{" "}
                      {(step.finding_ids?.length ?? 0)} findings
                    </small>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="event-strip">
            <div className="pane-title compact">
              <div>
                <p className="eyebrow">Browser events</p>
                <h3>Signals and loads</h3>
              </div>
              <button className="quiet-button" onClick={() => setEvents([])} type="button">Clear</button>
            </div>
            <pre className="events-log">{events.join("\n") || "No browser events."}</pre>
          </section>
        </section>

        <aside className="inspector" aria-label="Review, evidence, sessions, and signals">
          <section className="inspector-section">
            <div className="pane-title compact">
              <div>
                <p className="eyebrow">Review inbox</p>
                <h3>Continuation</h3>
              </div>
              <span className={openInbox.length > 0 ? "count-chip attention" : "count-chip good"}>{openInbox.length} open</span>
            </div>
            <div className="inbox-list">
              {inbox.length === 0 ? <EmptyLine text="No inbox items." /> : null}
              {inbox.map((item) => (
                <article className="inbox-item" key={item.id}>
                  <div>
                    <strong>{item.title ?? item.id}</strong>
                    <p>{item.detail ?? item.action?.reason ?? "No detail recorded."}</p>
                    <small>{item.status} · {item.action?.kind ?? "triage"}</small>
                  </div>
                  <div className="button-row">
                    <button disabled={!selectedWorkflowId || item.status !== "open"} onClick={() => void executeInbox(item.id)} type="button">
                      <Send size={15} /> Continue
                    </button>
                    <button className="quiet-button" disabled={!selectedWorkflowId || item.status !== "open"} onClick={() => void dismissInbox(item.id)} type="button">
                      Dismiss
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <details className="control-drawer" open>
              <summary>Worker and review controls</summary>
              <form className="control-grid" ref={inboxFormRef}>
                <label>Verify command<input defaultValue={defaultVerifyCommand} name="verify_command" /></label>
                <label>Dismiss reason<input name="dismiss_reason" placeholder="Why this item does not need work" /></label>
                <label>Worker command<input name="command" placeholder="Custom worker command" /></label>
                <label>Worker agent<input name="agent" placeholder="codex, claude, custom" /></label>
                <label>Worker goal<textarea name="goal" placeholder="Instruction for the next work attempt" /></label>
                <label>Resume command<input name="resume_command" placeholder="Resume command" /></label>
                <label>Worker candidates<textarea name="worker_candidates" placeholder='[{"agent":"codex","command":"codex exec --json"}]' /></label>
                <label>Review command<input name="review_command" placeholder="Review command" /></label>
                <label>Review agent<input name="review_agent" placeholder="Review agent" /></label>
                <label>Review candidates<textarea name="review_candidates" placeholder='[{"agent":"codex","command":"codex exec --json"}]' /></label>
                <label>Command timeout ms<input name="command_timeout_ms" placeholder="Command timeout ms" type="number" /></label>
              </form>
            </details>
          </section>

          <section className="inspector-section">
            <div className="pane-title compact">
              <div>
                <p className="eyebrow">Evidence</p>
                <h3>Artifacts and live output</h3>
              </div>
              <span className="count-chip">{artifacts.length + attempts.length}</span>
            </div>
            <div className="evidence-grid">
              <div className="evidence-list">
                {artifacts.length === 0 && attempts.length === 0 ? <EmptyLine text="No artifacts or live logs." /> : null}
                {artifacts.map((artifact) => (
                  <button
                    className="evidence-row"
                    key={artifact.id}
                    onClick={() => void previewText(`/artifact?workflow_id=${encodeURIComponent(selectedWorkflowId)}&id=${artifact.id}`)}
                    type="button"
                  >
                    <Archive size={15} />
                    <span>{artifact.kind}</span>
                  </button>
                ))}
                {attempts.map((attempt) => (
                  <button
                    className="evidence-row"
                    key={attempt.id}
                    onClick={() => void previewText(`/log?workflow_id=${encodeURIComponent(selectedWorkflowId)}&attempt=${attempt.id}`)}
                    type="button"
                  >
                    <Activity size={15} />
                    <span>{attempt.type} · {attempt.status}</span>
                  </button>
                ))}
              </div>
              <pre className="preview">{preview}</pre>
            </div>
          </section>

          <section className="inspector-section">
            <div className="pane-title compact">
              <div>
                <p className="eyebrow">Agent sessions</p>
                <h3>Resume handles</h3>
              </div>
              <span className="count-chip">{sessions.length}</span>
            </div>
            <div className="session-list">
              {sessions.length === 0 ? <EmptyLine text="No sessions recorded." /> : null}
              {sessions.map((session) => (
                <article className="session-row" key={session.id}>
                  <strong>{session.id}</strong>
                  <span>{session.agent} · {session.role} · {session.status}</span>
                  {session.external_session_id ? <code>{session.external_session_id}</code> : null}
                </article>
              ))}
            </div>
            <details className="control-drawer">
              <summary>Manual session signals</summary>
              <div className="signal-forms">
                <form onSubmit={(event) => void registerSession(event)}>
                  <h4>Register session</h4>
                  <input name="session_id" placeholder="Session id" />
                  <input defaultValue="codex" name="agent" placeholder="Agent" />
                  <input name="session_cwd" placeholder="Session cwd" />
                  <input name="resume_command" placeholder="Resume command" />
                  <button disabled={!selectedWorkflowId} type="submit">Send register signal</button>
                </form>
                <form onSubmit={(event) => void resumeSession(event)}>
                  <h4>Resume session</h4>
                  <input name="session_id" placeholder="Session id" />
                  <textarea name="prompt" placeholder="Prompt" />
                  <input defaultValue={defaultVerifyCommand} name="verify_command" placeholder="Verify command" />
                  <button disabled={!selectedWorkflowId} type="submit">Send resume signal</button>
                </form>
              </div>
            </details>
          </section>
        </aside>
      </main>
    </div>
  );
}

function InlineMetric({
  label,
  tone = "neutral",
  value
}: {
  label: string;
  tone?: "neutral" | "attention" | "danger";
  value: number | string;
}) {
  return (
    <span className={`inline-metric ${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${toneForStatus(status)}`}>{status}</span>;
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${toneForStatus(status)}`} />;
}

function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
}

function actionForRun({
  failedSteps,
  loading,
  openInbox,
  selectedWorkflowId
}: {
  failedSteps: WorkflowStep[];
  loading: boolean;
  openInbox: InboxItem[];
  selectedWorkflowId: string;
}): {
  body: string;
  icon: ReactNode;
  title: string;
  tone: "neutral" | "attention" | "danger" | "good";
} {
  if (!selectedWorkflowId) {
    return {
      body: "Pick a workflow from the queue to inspect its Temporal-owned state.",
      icon: <RadioTower size={18} />,
      title: "No run selected",
      tone: "neutral"
    };
  }
  if (loading) {
    return {
      body: "Fetching run result, inbox, sessions, artifacts, and live output from Temporal-backed endpoints.",
      icon: <Clock3 size={18} />,
      title: "Loading run context",
      tone: "attention"
    };
  }
  if (openInbox.length > 0) {
    return {
      body: `${openInbox.length} review item needs continue or dismiss.`,
      icon: <Inbox size={18} />,
      title: "Review decision waiting",
      tone: "attention"
    };
  }
  if (failedSteps.length > 0) {
    return {
      body: `${failedSteps.length} step failed, blocked, or timed out. Check evidence before resuming work.`,
      icon: <CircleAlert size={18} />,
      title: "Failure evidence needed",
      tone: "danger"
    };
  }
  return {
    body: "No open review item is blocking this workflow.",
    icon: <CheckCircle2 size={18} />,
    title: "No blocking action",
    tone: "good"
  };
}

function addString(payload: Record<string, unknown>, values: FormData, key: string) {
  const value = formString(values, key);
  if (value) payload[key] = value;
}

function addNumber(payload: Record<string, unknown>, values: FormData, key: string) {
  const raw = formString(values, key);
  if (raw) payload[key] = Number(raw);
}

function addJSON(payload: Record<string, unknown>, values: FormData, key: string) {
  const raw = formString(values, key);
  if (raw) payload[key] = JSON.parse(raw);
}

function formString(values: FormData, key: string, defaultValue = ""): string {
  const value = String(values.get(key) ?? "").trim();
  return value ? value : defaultValue;
}

function toneForStatus(status: string): "good" | "attention" | "danger" | "neutral" {
  const normalized = status.toLowerCase();
  if (["completed", "succeeded", "success"].includes(normalized)) {
    return "good";
  }
  if (["failed", "blocked", "timed_out", "canceled", "terminated"].includes(normalized)) {
    return "danger";
  }
  if (["running", "retrying", "waiting_user"].includes(normalized)) {
    return "attention";
  }
  return "neutral";
}
