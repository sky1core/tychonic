import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react"
import { Streamdown } from "streamdown"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  InboxIcon,
  ListRestartIcon,
  RefreshCcwIcon,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Message,
  MessageContent,
  MessageMetadata,
  MessageMetadataItem,
} from "@/components/ai-elements/message"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { uiLabAccent } from "@/lib/ui-lab/style-contract"
import { cn } from "@/lib/utils"
import { extractAgentResult } from "./agentResult"
import { responseTextForDisplay, stateCommandForDisplay } from "./stateEvidence"

type WorkflowSummary = {
  workflowId: string
  runId: string
  type: string
  taskQueue: string
  status: string
  historyLength?: number
  startTime: string
  executionTime?: string
  closeTime?: string
  cwd?: string
}

type WorkflowStateRecord = {
  id: string
  name: string
  status: string
  reason: string
  activity_attempt_ids: string[]
  artifact_ids: string[]
  finding_ids: string[]
  started_at?: string
  finished_at?: string
}

type WorkflowEvidence = {
  runId: string
  template: string
  status: string
  summary?: string
  latest_state?: WorkflowStateRecord
  states: WorkflowStateRecord[]
  state_attempt_summaries: Array<{
    id: string
    state_id: string
    state_name?: string
    kind: string
    status: string
    command?: string
    agent_session_id?: string
  }>
  counts: Record<"states" | "attempts" | "artifacts" | "logs" | "inbox" | "sessions" | "findings", number>
  inbox: Array<{
    id: string
    status: string
    title: string
    detail: string
    created_at: string
  }>
  artifacts: Array<{
    id: string
    kind: string
    path: string
    created_at: string
    read_command: string
  }>
  logs: Array<{
    id: string
    state_name?: string
    kind: string
    status: string
    reason: string
    duration_ms?: number
    read_command: string
  }>
  sessions: Array<{
    id: string
    agent: string
    role: string
    status: string
    resumable?: boolean
    prompt_artifact_id?: string
    result_artifact_id?: string
    transcript_artifact_id?: string
    diff_artifact_id?: string
    started_at: string
    finished_at?: string
  }>
  findings: Array<{
    id: string
    status: string
    severity: string
    title: string
    detail: string
    target?: string
    created_at: string
  }>
  timing: {
    run_ms?: number
    activity_ms: number
    non_activity_ms?: number
    activity_count: number
    by_kind: Array<{ kind: string; count: number; duration_ms: number }>
    slowest_attempts: Array<{
      id: string
      state_name?: string
      kind: string
      status: string
      duration_ms: number
    }>
  }
}

type WorkflowDetail = {
  ok: boolean
  request: {
    workflowId: string
    runId: string
  }
  workflow: WorkflowSummary & {
    pendingActivityCount?: number
    pendingActivities?: unknown[]
    inputError?: string
    resultError?: string
  }
  runContext?: {
    cwd?: string
    goal?: string
    promptAdditions?: Record<string, string>
    createdAt?: string
    updatedAt?: string
    artifactRoot?: string
    profileSnapshotArtifactId?: string
    inputError?: string
  }
  evidence?: WorkflowEvidence
  evidenceError?: string
  artifactContents?: Record<string, { content: string }>
  activeStateEvidence?: { promptContent?: string; liveOutput?: string }
  stateConfigs?: Record<string, { type?: string; command?: string; agent?: string; model?: string; timeout?: string }>
  workflowGraph?: {
    mermaid: string
    definition: WorkflowDefinitionGraph
  }
  workflowGraphError?: string
  error?: string
}

type WorkflowDefinitionGraph = {
  start: string
  maxSteps: number
  states: Array<{
    name: string
    type: string
    reviewReturnTo?: string
  }>
  edges: Array<{
    id: string
    from: string
    label: "pass" | "fail"
    to?: string
    finish?: boolean
  }>
}

type WorkflowList = {
  ok: boolean
  address: string
  namespace: string
  taskQueue: string
  workflows: WorkflowSummary[]
  error?: string
}

type BadgeTone = "default" | "secondary" | "destructive" | "outline"

const statusTone: Record<string, BadgeTone> = {
  RUNNING: "default",
  running: "default",
  succeeded: "secondary",
  COMPLETED: "secondary",
  failed: "destructive",
  FAILED: "destructive",
  blocked: "destructive",
  timed_out: "destructive",
  TIMED_OUT: "destructive",
  TERMINATED: "destructive",
  waiting_user: "outline",
  cancelled: "outline",
  CANCELED: "outline",
  CONTINUED_AS_NEW: "outline",
}

const findingSeverityTone: Record<string, BadgeTone> = {
  blocker: "destructive",
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
  info: "outline",
}

const streamdownLinkSafety = { enabled: false } as const

function parseHashSelection(): { workflowId: string; runId: string } | undefined {
  const hash = window.location.hash.slice(1)
  if (!hash) return undefined
  const params = new URLSearchParams(hash)
  const workflowId = params.get("wf")
  const runId = params.get("run")
  if (workflowId && runId) return { workflowId, runId }
  return undefined
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function App() {
  const initialSelection = useRef(parseHashSelection()).current
  const selectedRunRef = useRef<{ workflowId?: string; runId?: string }>(initialSelection ?? {})
  const listRequestSeqRef = useRef(0)
  const listLoadingRequestSeqRef = useRef<number | undefined>(undefined)
  const loadWorkflowsRef = useRef<
    | ((
        nextSelection?: { workflowId: string; runId: string },
        reloadCurrentDetail?: boolean,
        options?: { showLoading?: boolean },
      ) => Promise<void>)
    | undefined
  >(undefined)
  const detailRequestSeqRef = useRef(0)
  const detailLoadingRequestSeqRef = useRef<number | undefined>(undefined)
  const [workflowList, setWorkflowList] = useState<WorkflowList>()
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | undefined>(initialSelection?.workflowId)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(initialSelection?.runId)
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail>()
  const [listLoading, setListLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [definitionOpen, setDefinitionOpen] = useState(false)
  const selectedWorkflow = workflowList?.workflows.find(
    (workflow) => workflow.workflowId === selectedWorkflowId && workflow.runId === selectedRunId,
  )
  const hasSelectedRun = selectedWorkflowId !== undefined && selectedRunId !== undefined

  function applySelection(selection: { workflowId: string; runId: string } | undefined) {
    const previous = selectedRunRef.current
    if (previous.workflowId !== selection?.workflowId || previous.runId !== selection?.runId) {
      detailRequestSeqRef.current += 1
      detailLoadingRequestSeqRef.current = undefined
      setDetailLoading(false)
      setWorkflowDetail(undefined)
    }
    selectedRunRef.current = selection ?? {}
    setSelectedWorkflowId(selection?.workflowId)
    setSelectedRunId(selection?.runId)
    if (selection) {
      const params = new URLSearchParams({ wf: selection.workflowId, run: selection.runId })
      window.history.replaceState(null, "", `#${params.toString()}`)
    } else {
      window.history.replaceState(null, "", window.location.pathname)
    }
  }

  async function loadWorkflows(
    nextSelection?: { workflowId: string; runId: string },
    reloadCurrentDetail = false,
    options: { showLoading?: boolean } = {},
  ) {
    const requestSeq = listRequestSeqRef.current + 1
    listRequestSeqRef.current = requestSeq
    const showLoading = options.showLoading ?? true
    if (showLoading) {
      listLoadingRequestSeqRef.current = requestSeq
      setListLoading(true)
    }
    setError(undefined)
    try {
      const response = await fetch("api/workflows?limit=30")
      const body = (await response.json()) as WorkflowList
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? `workflow list request failed with ${response.status}`)
      }
      if (listRequestSeqRef.current !== requestSeq) {
        return
      }
      setWorkflowList(body)
      const explicitSelection = nextSelection
      const currentRunSelection = selectedRunRef.current
      const currentSelection =
        currentRunSelection.workflowId && currentRunSelection.runId
          ? { workflowId: currentRunSelection.workflowId, runId: currentRunSelection.runId }
          : undefined
      const next = explicitSelection ?? currentSelection
      const selectionChanged = next?.workflowId !== currentSelection?.workflowId || next?.runId !== currentSelection?.runId
      applySelection(next)
      if (!next) {
        setWorkflowDetail(undefined)
        setDetailLoading(false)
      } else if (reloadCurrentDetail && !selectionChanged) {
        await loadWorkflowDetail(next.workflowId, next.runId, { showLoading })
      }
    } catch (loadError) {
      if (listRequestSeqRef.current === requestSeq) {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    } finally {
      if (showLoading && listLoadingRequestSeqRef.current === requestSeq) {
        listLoadingRequestSeqRef.current = undefined
        setListLoading(false)
      }
    }
  }

  async function loadWorkflowDetail(workflowId: string, runId: string, options: { showLoading?: boolean } = {}) {
    const showLoading = options.showLoading ?? true
    const requestSeq = detailRequestSeqRef.current + 1
    detailRequestSeqRef.current = requestSeq
    if (showLoading) {
      detailLoadingRequestSeqRef.current = requestSeq
      setDetailLoading(true)
    }
    setError(undefined)
    setWorkflowDetail((current) =>
      current?.request.workflowId === workflowId && current.request.runId === runId ? current : undefined,
    )
    try {
      const response = await fetch(`api/workflows/${encodeURIComponent(workflowId)}?runId=${encodeURIComponent(runId)}`)
      const body = (await response.json()) as WorkflowDetail
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? `workflow detail request failed with ${response.status}`)
      }
      const currentSelection = selectedRunRef.current
      if (currentSelection.workflowId !== workflowId || currentSelection.runId !== runId) {
        return
      }
      if (detailRequestSeqRef.current !== requestSeq) {
        return
      }
      setWorkflowDetail({ ...body, request: { workflowId, runId } })
    } catch (loadError) {
      const currentSelection = selectedRunRef.current
      if (
        currentSelection.workflowId === workflowId &&
        currentSelection.runId === runId &&
        detailRequestSeqRef.current === requestSeq
      ) {
        setWorkflowDetail(undefined)
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    } finally {
      if (showLoading && detailLoadingRequestSeqRef.current === requestSeq) {
        detailLoadingRequestSeqRef.current = undefined
        setDetailLoading(false)
      }
    }
  }

  useEffect(() => {
    loadWorkflowsRef.current = loadWorkflows
  })

  useEffect(() => {
    let active = true
    void (async () => {
      setListLoading(true)
      setError(undefined)
      try {
        const response = await fetch("api/workflows?limit=30")
        const body = (await response.json()) as WorkflowList
        if (!response.ok || !body.ok) {
          throw new Error(body.error ?? `workflow list request failed with ${response.status}`)
        }
        if (!active) return
        setWorkflowList(body)
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (active) setListLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!selectedWorkflowId || !selectedRunId) return
    void loadWorkflowDetail(selectedWorkflowId, selectedRunId)
  }, [selectedWorkflowId, selectedRunId])

  const workflows = useMemo(() => workflowList?.workflows ?? [], [workflowList])
  const selectedRunReceivesEvents =
    selectedWorkflow?.status === "RUNNING" ||
    workflowDetail?.workflow.status === "RUNNING" ||
    workflowDetail?.evidence?.status === "running"

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setError("This browser does not support workflow event refresh. Use Refresh to update status.")
      return
    }
    const params = new URLSearchParams({ limit: "30" })
    if (selectedRunReceivesEvents && selectedWorkflowId && selectedRunId) {
      params.set("workflowId", selectedWorkflowId)
      params.set("runId", selectedRunId)
    }
    const events = new EventSource(`api/events?${params.toString()}`)
    const refresh = () => {
      void loadWorkflowsRef.current?.(undefined, selectedRunReceivesEvents, { showLoading: false })
    }
    const statusError = (event: Event) => {
      const payload = event instanceof MessageEvent ? parseJsonRecord(event.data) : undefined
      setError(typeof payload?.message === "string" ? payload.message : "workflow event refresh failed")
    }
    const connectionError = () => {
      setError("Workflow event refresh connection failed. Use Refresh to update status.")
    }
    events.addEventListener("refresh", refresh)
    events.addEventListener("error", connectionError)
    events.addEventListener("status_error", statusError)
    return () => events.close()
  }, [selectedWorkflowId, selectedRunId, selectedRunReceivesEvents])

  useEffect(() => {
    if (!workflowDetail?.workflowGraph) setDefinitionOpen(false)
  }, [workflowDetail?.workflowGraph])

  const runSummary = useMemo(
    () => workflowDetail?.evidence ? workflowRunSummary(workflowDetail.evidence) : undefined,
    [workflowDetail],
  )
  const currentWorkflowStatus = workflowDetail?.evidence?.status ?? workflowDetail?.workflow.status ?? selectedWorkflow?.status
  const selectedWorkflowDuration =
    currentWorkflowStatus === "running" || currentWorkflowStatus === "RUNNING"
      ? selectedWorkflow
        ? formatOpenWorkflowDuration(selectedWorkflow)
        : ""
      : workflowDetail?.evidence?.timing.run_ms != null
        ? formatDuration(workflowDetail.evidence.timing.run_ms)
        : selectedWorkflow
          ? formatWorkflowDuration(selectedWorkflow)
          : ""
  const completedActivitySummary = workflowDetail?.evidence?.timing.run_ms != null
    ? `${formatDuration(workflowDetail.evidence.timing.activity_ms)} / ${workflowDetail.evidence.timing.activity_count} act`
    : undefined
  const pendingActivitySummary = workflowDetail?.workflow.pendingActivityCount
    ? `${workflowDetail.workflow.pendingActivityCount} pending`
    : undefined
  const executionSteps = useMemo(() => {
    const evidence = workflowDetail?.evidence
    if (!evidence) return []
    const states = [...evidence.states]
    if (evidence.latest_state && !states.some((state) => state.id === evidence.latest_state?.id)) {
      states.push(evidence.latest_state)
    }
    const attemptByStateId = new Map(evidence.state_attempt_summaries.map((attempt) => [attempt.state_id, attempt]))
    return states.map((state, index) => ({
      state,
      index,
      attempt: attemptByStateId.get(state.id),
    }))
  }, [workflowDetail])
  const [selectedExecutionStateId, setSelectedExecutionStateId] = useState<string>()
  const executionRunKey = `${selectedWorkflowId ?? ""}:${selectedRunId ?? ""}`
  const previousExecutionRunKeyRef = useRef(executionRunKey)
  const stateFlowListRef = useRef<HTMLDivElement>(null)
  const stateFlowDotRefs = useRef<Array<HTMLSpanElement | null>>([])
  const [stateFlowLine, setStateFlowLine] = useState<{ top: number; height: number }>()
  const selectedExecutionStep = useMemo(
    () => executionSteps.find(({ state }) => state.id === selectedExecutionStateId),
    [executionSteps, selectedExecutionStateId],
  )
  useEffect(() => {
    if (previousExecutionRunKeyRef.current === executionRunKey) return
    previousExecutionRunKeyRef.current = executionRunKey
    setSelectedExecutionStateId(undefined)
  }, [executionRunKey])
  useEffect(() => {
    if (executionSteps.length === 0) {
      if (selectedExecutionStateId !== undefined) setSelectedExecutionStateId(undefined)
      return
    }
    if (selectedExecutionStateId && executionSteps.some(({ state }) => state.id === selectedExecutionStateId)) return
    const latestProblem = executionSteps.findLast(({ state }) => isProblemStatus(state.status))
    setSelectedExecutionStateId((latestProblem ?? executionSteps.at(-1))?.state.id)
  }, [executionSteps, selectedExecutionStateId])
  useLayoutEffect(() => {
    stateFlowDotRefs.current = stateFlowDotRefs.current.slice(0, executionSteps.length)
    const list = stateFlowListRef.current
    const firstDot = stateFlowDotRefs.current[0]
    const lastDot = stateFlowDotRefs.current.at(-1)
    if (!list || !firstDot || !lastDot || executionSteps.length < 2) {
      setStateFlowLine(undefined)
      return
    }
    const updateLine = () => {
      const listRect = list.getBoundingClientRect()
      const firstRect = firstDot.getBoundingClientRect()
      const lastRect = lastDot.getBoundingClientRect()
      const top = firstRect.top + firstRect.height / 2 - listRect.top
      const bottom = lastRect.top + lastRect.height / 2 - listRect.top
      const next = { top, height: Math.max(0, bottom - top) }
      setStateFlowLine((current) =>
        current && Math.abs(current.top - next.top) < 0.5 && Math.abs(current.height - next.height) < 0.5
          ? current
          : next,
      )
    }
    updateLine()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateLine)
    observer?.observe(list)
    observer?.observe(firstDot)
    observer?.observe(lastDot)
    window.addEventListener("resize", updateLine)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", updateLine)
    }
  }, [executionSteps])
  const selectedExecutionDetail = useMemo(() => {
    const step = selectedExecutionStep
    const detail = workflowDetail
    if (!step || !detail?.evidence) return undefined
    const state = step.state
    const session = step.attempt?.agent_session_id
      ? detail.evidence.sessions.find((candidate) => candidate.id === step.attempt?.agent_session_id)
      : undefined
    const isRunningState = state.status === "running"
    const activeEvidence = isRunningState ? detail.activeStateEvidence : undefined
    const promptContent = session?.prompt_artifact_id
      ? artifactDisplayContent(detail.artifactContents?.[session.prompt_artifact_id])
      : activeEvidence?.promptContent ?? undefined
    const stateArtifacts = detail.evidence.artifacts.filter((artifact) => state.artifact_ids.includes(artifact.id))
    const responseArtifact = session?.result_artifact_id ? detail.artifactContents?.[session.result_artifact_id] : undefined
    const parsedResponseArtifact = stateArtifacts.find((artifact) => artifact.kind === `${state.name}_parsed`)
    const parsedResponseContent = parsedResponseArtifact
      ? artifactDisplayContent(detail.artifactContents?.[parsedResponseArtifact.id])
      : undefined
    const liveResponseContent = activeEvidence?.liveOutput
      ? extractAgentResult(activeEvidence.liveOutput)
      : undefined
    const responseContent =
      responseArtifact
        ? extractAgentResult(responseArtifact.content)
        : parsedResponseContent
          ? extractAgentResult(parsedResponseContent)
          : liveResponseContent
    const hasResponseContent = Boolean(responseContent?.trim())
    const shouldShowPromptAsAgentMessage =
      Boolean(promptContent) && (session?.agent !== "custom" || hasResponseContent || state.status !== "succeeded")
    const outputArtifacts = stateArtifacts.filter(
      (artifact) =>
        isOutputArtifactKind(artifact.kind) &&
        artifact.id !== session?.prompt_artifact_id &&
        artifact.id !== session?.result_artifact_id,
    )
    const outputItems = outputArtifacts.map((artifact) => ({
      artifact,
      content: artifactDisplayContent(detail.artifactContents?.[artifact.id]),
    }))
    const findings = detail.evidence.findings.filter((finding) => state.finding_ids.includes(finding.id))
    const stateConfig = detail.stateConfigs?.[state.name]
    return {
      command: stateCommandForDisplay({
        attemptAgentSessionId: step.attempt?.agent_session_id,
        attemptCommand: step.attempt?.command,
        sessionAgent: session?.agent,
        stateConfigAgent: stateConfig?.agent,
        stateConfigCommand: stateConfig?.command,
      }),
      findings,
      outputItems,
      promptContent: shouldShowPromptAsAgentMessage ? promptContent : undefined,
      responseContent,
      isStreamingResponse: isRunningState && liveResponseContent !== undefined,
      session,
      stateConfig,
    }
  }, [selectedExecutionStep, workflowDetail])
  function openWorkflow(workflow: WorkflowSummary) {
    const currentSelection = selectedRunRef.current
    const sameSelection = currentSelection.workflowId === workflow.workflowId && currentSelection.runId === workflow.runId
    applySelection({ workflowId: workflow.workflowId, runId: workflow.runId })
    if (sameSelection) {
      void loadWorkflowDetail(workflow.workflowId, workflow.runId)
    }
  }
  const sidebarContent = (
    <>
      <SidebarHeader className="h-14 justify-center border-b px-3 py-0">
        <span className="text-sm font-semibold">Runs</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu className="py-1">
          {listLoading ? (
            <SidebarMenuItem>
              <div className="flex flex-col gap-1 px-2 py-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            </SidebarMenuItem>
          ) : workflows.length === 0 ? (
            <SidebarMenuItem>
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No workflows
              </div>
            </SidebarMenuItem>
          ) : (
            workflows.map((workflow) => {
              const selected = workflow.workflowId === selectedWorkflowId && workflow.runId === selectedRunId
              const statusIcon = workflow.status === "COMPLETED"
                ? <span className="text-emerald-600 dark:text-emerald-400"><CheckCircle2Icon className="h-3.5 w-3.5" /></span>
                : workflow.status === "RUNNING"
                  ? <span className="relative flex h-3.5 w-3.5 items-center justify-center"><span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-blue-500 opacity-40" /><span className="relative h-2 w-2 rounded-full bg-blue-500" /></span>
                  : workflow.status === "FAILED" || workflow.status === "TERMINATED" || workflow.status === "TIMED_OUT"
                    ? <span className="text-destructive"><AlertCircleIcon className="h-3.5 w-3.5" /></span>
                    : <span className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30" />
              const workflowButton = (
                <button
                  type="button"
                  onClick={() => openWorkflow(workflow)}
                  className="flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden px-3 py-2 text-left"
                >
                  {statusIcon}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline justify-between gap-1">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{projectName(workflow.cwd) ?? workflow.type}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatWorkflowDuration(workflow)}</span>
                    </div>
                    <div className="min-w-0 truncate text-xs text-muted-foreground">
                      {workflow.type}
                    </div>
                    <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 truncate tabular-nums">{formatTimePrecise(workflow.startTime)}</span>
                      <span className="shrink-0">{formatRelativeTime(workflow.startTime)}</span>
                    </div>
                  </div>
                </button>
              )
              return (
                <SidebarMenuItem key={`${workflow.workflowId}:${workflow.runId}`}>
                  <SidebarMenuButton
                    asChild
                    closeOnClick
                    isActive={selected}
                    className={cn("h-auto min-h-16 rounded-none p-0", selected && uiLabAccent.navSelected)}
                    tooltip={projectName(workflow.cwd) ?? workflow.type}
                  >
                    {workflowButton}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            })
          )}
        </SidebarMenu>
      </SidebarContent>
    </>
  )

  return (
    <TooltipProvider>
      <SidebarProvider
        style={{
          "--sidebar-width": "280px",
        } as CSSProperties}
      >
        <Sidebar collapsible="offcanvas">
          {sidebarContent}
        </Sidebar>

        <SidebarInset className="min-w-0">
          <header className="border-b bg-card">
            <div className="flex h-14 w-full items-center justify-between gap-2 px-3 lg:px-6">
              <div className="flex min-w-0 items-center gap-2">
                <SidebarTrigger className="shrink-0" />
                <h1 className="truncate text-base font-semibold lg:text-xl">Tychonic Workflows</h1>
                <div className="hidden items-center gap-2 text-sm text-muted-foreground lg:flex">
                  <span>{workflowList?.address}</span>
                  {workflowList ? <Badge variant="outline">{workflowList.taskQueue}</Badge> : null}
                </div>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadWorkflows(undefined, true)}
                    disabled={listLoading || detailLoading}
                  >
                    <RefreshCcwIcon data-icon="inline-start" />
                    <span className="hidden sm:inline">Refresh</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reload workflow list and selected evidence</TooltipContent>
              </Tooltip>
            </div>
          </header>

          <div className="flex-1 overflow-x-hidden overflow-y-auto p-3 lg:p-6">
            <div className="flex flex-col gap-2 lg:gap-4">
              {error ? (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Status UI error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              {!hasSelectedRun ? (
                <Card>
                  <CardContent>
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <InboxIcon />
                        </EmptyMedia>
                        <EmptyTitle>Select a workflow</EmptyTitle>
                        <EmptyDescription>Choose a run from the recent workflow list.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Header */}
                  <div className="flex min-h-11 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <h2 className="truncate text-base font-semibold lg:text-lg">
                        {workflowDetail?.evidence?.template ?? selectedWorkflow?.type ?? "Workflow"}
                      </h2>
                      <Badge variant={statusTone[workflowDetail?.evidence?.status ?? workflowDetail?.workflow.status ?? selectedWorkflow?.status ?? ""] ?? "outline"}>
                        {workflowDetail?.evidence?.status ?? workflowDetail?.workflow.status ?? selectedWorkflow?.status ?? "unknown"}
                      </Badge>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {selectedWorkflowDuration}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {workflowDetail?.runContext?.cwd ? (
                      <span className="max-w-[180px] truncate font-mono lg:max-w-none">{workflowDetail.runContext.cwd}</span>
                    ) : null}
                    {selectedWorkflow?.startTime ? <span>{formatDatePrecise(selectedWorkflow.startTime)}</span> : null}
                    {completedActivitySummary ? <span>{completedActivitySummary}</span> : null}
                    {pendingActivitySummary ? <span>{pendingActivitySummary}</span> : null}
                  </div>
                  {runSummary?.activeState?.status === "running" ? (
                    <Alert aria-live="polite" className="border-blue-500/30 bg-blue-500/10">
                      <span className="relative mt-0.5 flex h-4 w-4 items-center justify-center">
                        <span className="absolute h-3.5 w-3.5 animate-ping rounded-full bg-blue-500 opacity-40" />
                        <span className="relative h-2.5 w-2.5 rounded-full bg-blue-500" />
                      </span>
                      <AlertTitle>Running now</AlertTitle>
                      <AlertDescription className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium text-foreground">{runSummary.activeState.name}</span>
                        {runSummary.activeState.started_at ? (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            started {formatTimePrecise(runSummary.activeState.started_at)}
                          </span>
                        ) : null}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {workflowDetail?.runContext?.goal ? (
                    <section className="rounded-md border bg-muted/20 px-3 py-2">
                      <h3 className="mb-1 text-xs font-medium text-muted-foreground">Goal</h3>
                      <div className="max-h-32 overflow-auto text-sm">
                        <Streamdown className="tychonic-markdown" linkSafety={streamdownLinkSafety} mode="static">
                          {workflowDetail.runContext.goal}
                        </Streamdown>
                      </div>
                    </section>
                  ) : null}

                  {(runSummary?.openInboxCount ?? 0) > 0 ? (
                    <Alert variant="destructive">
                      <AlertCircleIcon />
                      <AlertTitle>{runSummary!.openInboxCount} operator decision(s) pending</AlertTitle>
                      <AlertDescription>
                        {workflowDetail?.evidence?.inbox.find(
                          (i) => i.status === "open" || i.status === "waiting" || i.status === "waiting_user",
                        )?.title ?? "Check inbox for details."}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {detailLoading ? (
                    <div className="flex flex-col gap-3">
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-[420px] w-full" />
                    </div>
                  ) : (
                    <>
                    {executionSteps.length > 0 ? (
                      <section className="grid min-w-0 gap-3 lg:grid-cols-[minmax(260px,360px)_minmax(0,1fr)] lg:items-start">
                        <div className="order-2 min-w-0 rounded-md border lg:order-1">
                          <div className="flex h-11 items-center justify-between gap-2 border-b px-3">
                            <h3 className="text-sm font-medium">State flow</h3>
                            <div className="flex items-center gap-2">
                              {workflowDetail?.workflowGraph ? (
                                <Button variant="outline" onClick={() => setDefinitionOpen(true)}>
                                  Definition
                                </Button>
                              ) : null}
                              <span className="text-xs tabular-nums text-muted-foreground">{executionSteps.length} events</span>
                            </div>
                          </div>
                          <div ref={stateFlowListRef} className="relative">
                            {stateFlowLine ? (
                              <span
                                aria-hidden="true"
                                className="pointer-events-none absolute left-7 z-10 w-px bg-border"
                                style={{ top: stateFlowLine.top, height: stateFlowLine.height }}
                              />
                            ) : null}
                            {executionSteps.map(({ state, index }) => {
                              const durationMs = stateDurationMs(state)
                              const failed = state.status === "failed" || state.status === "timed_out"
                              const running = state.status === "running"
                              const blocked = state.status === "blocked"
                              const succeeded = state.status === "succeeded"
                              const selected = state.id === selectedExecutionStateId
                              return (
                                <Message key={state.id} from="assistant" className="max-w-full gap-0">
                                  <MessageContent className="w-full">
                                    <button
                                      type="button"
                                      aria-current={selected ? "true" : undefined}
                                      onClick={() => setSelectedExecutionStateId(state.id)}
                                      className={cn(
                                        "relative flex w-full gap-2 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                                        (failed || blocked) && "bg-destructive/5",
                                        running && "bg-blue-500/10",
                                        selected && "bg-primary/10 text-foreground ring-2 ring-primary/70 shadow-sm",
                                      )}
                                    >
                                      {selected ? (
                                        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-1.5 bg-primary" />
                                      ) : null}
                                      <span className="relative flex w-8 shrink-0 justify-center pt-0.5">
                                        <span
                                          ref={(element) => {
                                            stateFlowDotRefs.current[index] = element
                                          }}
                                          className={cn(
                                            "relative z-20 flex h-5 w-5 items-center justify-center rounded-full bg-background",
                                            selected && "ring-2 ring-primary",
                                          )}
                                        >
                                          {succeeded ? (
                                            <span className="text-emerald-600 dark:text-emerald-400"><CheckCircle2Icon className="h-4 w-4" /></span>
                                          ) : failed || blocked ? (
                                            <span className="text-destructive"><AlertCircleIcon className="h-4 w-4" /></span>
                                          ) : running ? (
                                            <span className="relative flex h-4 w-4 items-center justify-center">
                                              <span className="absolute h-3 w-3 animate-ping rounded-full bg-blue-500 opacity-40" />
                                              <span className="relative h-2.5 w-2.5 rounded-full bg-blue-500" />
                                            </span>
                                          ) : (
                                            <span className="h-2.5 w-2.5 rounded-full border-2 border-muted-foreground/30" />
                                          )}
                                        </span>
                                      </span>
                                      <span className="min-w-0 flex-1">
                                        <MessageMetadata>
                                          <MessageMetadataItem className="tabular-nums">#{index + 1}</MessageMetadataItem>
                                          {durationMs != null && durationMs > 0 ? (
                                            <MessageMetadataItem className="tabular-nums">{formatDuration(durationMs)}</MessageMetadataItem>
                                          ) : null}
                                        </MessageMetadata>
                                        <span className="mt-1 flex min-w-0 items-center gap-2">
                                          <span className={cn("min-w-0 truncate text-sm font-medium", (failed || blocked) && "text-destructive")}>
                                            {state.name}
                                          </span>
                                          <Badge variant={statusTone[state.status] ?? "outline"} className="shrink-0">
                                            {state.status}
                                          </Badge>
                                        </span>
                                      </span>
                                    </button>
                                  </MessageContent>
                                </Message>
                              )
                            })}
                          </div>
                        </div>

                        <div className="order-1 min-w-0 rounded-md border bg-card lg:sticky lg:top-3 lg:order-2">
                          {selectedExecutionStep ? (
                            <div>
                              <div
                                className={cn(
                                  "flex h-11 items-center border-b px-3",
                                  selectedExecutionStep.state.status === "running" && "bg-blue-500/10",
                                )}
                              >
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  {selectedExecutionStep.state.status === "running" ? (
                                    <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                                      <span className="absolute h-3 w-3 animate-ping rounded-full bg-blue-500 opacity-40" />
                                      <span className="relative h-2.5 w-2.5 rounded-full bg-blue-500" />
                                    </span>
                                  ) : null}
                                  <span className="text-sm font-medium">
                                    {selectedExecutionStep.index + 1}. {selectedExecutionStep.state.name}
                                  </span>
                                  <Badge variant={statusTone[selectedExecutionStep.state.status] ?? "outline"}>
                                    {selectedExecutionStep.state.status}
                                  </Badge>
                                  {stateDurationMs(selectedExecutionStep.state) != null ? (
                                    <span className="text-xs tabular-nums text-muted-foreground">
                                      {formatDuration(stateDurationMs(selectedExecutionStep.state)!)}
                                    </span>
                                  ) : null}
                                </div>
                              </div>

                              <div className="space-y-4 p-3">
                                {selectedExecutionDetail?.session ||
                                selectedExecutionDetail?.stateConfig?.agent ||
                                selectedExecutionDetail?.stateConfig?.model ? (
                                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    {selectedExecutionDetail?.session ? (
                                      <>
                                        <Badge variant="outline">{selectedExecutionDetail.session.agent}</Badge>
                                        <span>{selectedExecutionDetail.session.role}</span>
                                        <span>{selectedExecutionDetail.session.status}</span>
                                      </>
                                    ) : selectedExecutionDetail?.stateConfig?.agent ? (
                                      <Badge variant="outline">{selectedExecutionDetail.stateConfig.agent}</Badge>
                                    ) : null}
                                    {selectedExecutionDetail?.stateConfig?.model ? <span>{selectedExecutionDetail.stateConfig.model}</span> : null}
                                  </div>
                                ) : null}
                                {selectedExecutionDetail?.command ? (
                                  <div className="rounded-md border bg-muted/20">
                                    <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">Tool command</div>
                                    <pre className="max-h-36 overflow-auto px-3 py-2 text-xs whitespace-pre-wrap break-words">{selectedExecutionDetail.command}</pre>
                                  </div>
                                ) : null}
                                {selectedExecutionDetail?.promptContent ? (
                                  <Message from="user">
                                    <MessageMetadata className="justify-end">
                                      <MessageMetadataItem>Prompt</MessageMetadataItem>
                                    </MessageMetadata>
                                    <MessageContent className="max-h-72 overflow-auto">
                                      <Streamdown className="tychonic-markdown" linkSafety={streamdownLinkSafety} mode="static">
                                        {selectedExecutionDetail.promptContent}
                                      </Streamdown>
                                    </MessageContent>
                                  </Message>
                                ) : null}
                                {responseTextForDisplay(selectedExecutionDetail?.responseContent) !== undefined ? (
                                  <Message from="assistant" className="max-w-full">
                                    <MessageMetadata>
                                      <MessageMetadataItem>Response</MessageMetadataItem>
                                    </MessageMetadata>
                                    <MessageContent className="max-h-[520px] w-full overflow-auto rounded-md px-1 py-1">
                                      <Streamdown className="tychonic-markdown" linkSafety={streamdownLinkSafety} mode={selectedExecutionDetail?.isStreamingResponse ? "streaming" : "static"}>
                                        {responseTextForDisplay(selectedExecutionDetail?.responseContent)}
                                      </Streamdown>
                                    </MessageContent>
                                  </Message>
                                ) : null}
                                {selectedExecutionDetail?.outputItems.map(({ artifact, content }) => (
                                  <div key={artifact.id} className="rounded-md border bg-muted/20">
                                    <div className="flex min-w-0 items-center gap-2 border-b px-3 py-1.5">
                                      <Badge variant="outline">{artifact.kind}</Badge>
                                      <span className="min-w-0 truncate text-xs text-muted-foreground">{artifact.path}</span>
                                    </div>
                                    <pre className="max-h-56 overflow-auto px-3 py-2 text-xs whitespace-pre-wrap">{content !== undefined ? content || "(empty output)" : "(artifact content unavailable)"}</pre>
                                  </div>
                                ))}
                                {selectedExecutionDetail?.findings.map((finding) => (
                                  <div key={finding.id} className="rounded-md border px-2 py-1.5 text-sm">
                                    <div className="flex items-center gap-2">
                                      <Badge variant={findingSeverityTone[finding.severity.toLowerCase()] ?? "outline"}>Severity: {finding.severity}</Badge>
                                      <span className="font-medium">{finding.title}</span>
                                    </div>
                                    {finding.detail ? <p className="mt-1 text-xs text-muted-foreground">{finding.detail}</p> : null}
                                  </div>
                                ))}
                                {selectedExecutionDetail &&
                                selectedExecutionDetail.outputItems.length === 0 &&
                                selectedExecutionDetail.findings.length === 0 &&
                                !selectedExecutionDetail.command &&
                                !selectedExecutionDetail.promptContent &&
                                selectedExecutionDetail.responseContent === undefined ? (
                                  <span className="text-sm text-muted-foreground">No inline evidence for this state event.</span>
                                ) : null}
                              </div>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">Select a state event.</span>
                          )}
                        </div>
                      </section>
                    ) : null}

                    {workflowDetail?.runContext?.inputError ?? workflowDetail?.workflow.inputError ? (
                      <div className="text-xs text-destructive">
                        input read error: {workflowDetail?.runContext?.inputError ?? workflowDetail?.workflow.inputError}
                      </div>
                    ) : null}

                    {/* Evidence \u2014 inline priority sections, data-present only */}
                    {workflowDetail?.evidenceError ? (
                      <Alert>
                        <AlertCircleIcon />
                        <AlertTitle>Evidence unavailable</AlertTitle>
                        <AlertDescription>{workflowDetail.evidenceError}</AlertDescription>
                      </Alert>
                    ) : workflowDetail?.evidence ? (
                      <div className="space-y-3">
                        {workflowDetail.evidence.findings.length > 0 ? (
                          <section>
                            <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Findings ({workflowDetail.evidence.findings.length})</h3>
                            <div className="space-y-1.5">
                              {workflowDetail.evidence.findings.map((finding) => (
                                <div key={finding.id} className="rounded-md border px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <Badge variant={findingSeverityTone[finding.severity.toLowerCase()] ?? "outline"} className="shrink-0">Severity: {finding.severity}</Badge>
                                    <span className="min-w-0 truncate text-sm font-medium">{finding.title}</span>
                                  </div>
                                  {finding.detail ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{finding.detail}</p> : null}
                                  {finding.target !== undefined ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">\u2192 {finding.target}</span> : null}
                                </div>
                              ))}
                            </div>
                          </section>
                        ) : null}

                        {(() => {
                          const stateArtifactIds = new Set(workflowDetail.evidence.states.flatMap(s => s.artifact_ids))
                          const profileId = workflowDetail.runContext?.profileSnapshotArtifactId
                          const runArtifacts = workflowDetail.evidence.artifacts.filter(a => !stateArtifactIds.has(a.id) && a.id !== profileId)
                          if (runArtifacts.length === 0) return null
                          return (
                            <section>
                              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Run evidence</h3>
                              <div className="space-y-1.5">
                                {runArtifacts.map((artifact) => {
                                  const ac = workflowDetail.artifactContents?.[artifact.id]
                                  const content = artifactDisplayContent(ac)
                                  return (
                                    <div key={artifact.id} className="rounded-md border">
                                      <div className="px-3 py-2">
                                        <div className="flex min-w-0 items-center gap-2">
                                          <Badge variant="outline" className="shrink-0">{artifactDisplayTitle(artifact.kind)}</Badge>
                                          {artifactDisplayPath(artifact) ? (
                                            <span className="min-w-0 truncate text-sm text-muted-foreground">{artifactDisplayPath(artifact)}</span>
                                          ) : null}
                                        </div>
                                        {artifactDisplayDescription(artifact.kind) ? (
                                          <p className="mt-1 text-xs text-muted-foreground">{artifactDisplayDescription(artifact.kind)}</p>
                                        ) : null}
                                      </div>
                                      {content ? (
                                        <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words border-t bg-muted/30 px-3 py-2 text-xs">{content}</pre>
                                      ) : null}
                                    </div>
                                  )
                                })}
                              </div>
                            </section>
                          )
                        })()}

                      </div>
                    ) : (
                      emptyPanel(ListRestartIcon, "No evidence snapshot", "The workflow has not exposed a Tychonic result yet.")
                    )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>

      <Dialog open={definitionOpen} onOpenChange={setDefinitionOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Definition</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[72dvh]">
            <div className="min-w-0 pr-2">
              {workflowDetail?.workflowGraph ? <MermaidDiagram source={workflowDetail.workflowGraph.mermaid} /> : null}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}


function formatWorkflowDuration(workflow: WorkflowSummary) {
  if (!workflow.closeTime) return "open"
  const startMs = Date.parse(workflow.startTime)
  const closeMs = Date.parse(workflow.closeTime)
  if (!Number.isFinite(startMs) || !Number.isFinite(closeMs) || closeMs < startMs) return "not reported"
  return formatDuration(closeMs - startMs)
}

function formatOpenWorkflowDuration(workflow: WorkflowSummary) {
  const startMs = Date.parse(workflow.startTime)
  if (!Number.isFinite(startMs)) return "open"
  return `open ${formatDuration(Math.max(0, Date.now() - startMs))}`
}

function workflowRunSummary(evidence: WorkflowEvidence) {
  const activeState =
    evidence.latest_state ??
    evidence.states.findLast((state) => state.status === "running" || state.status === "blocked" || state.status === "timed_out") ??
    evidence.states.at(-1)
  const openInboxCount = evidence.inbox.filter((item) => item.status === "open" || item.status === "waiting" || item.status === "waiting_user").length
  const lastProblemState = evidence.states.findLast((state) => isProblemStatus(state.status))
  const returnEvents = reviewReturnEvents(evidence)
  const nextAction =
    openInboxCount > 0
      ? "Operator decision pending"
      : evidence.status === "running"
        ? activeState
          ? `Watch ${activeState.name}`
          : "Watch running workflow"
        : evidence.status === "waiting_user"
          ? "Operator decision pending"
          : evidence.status === "succeeded"
            ? "Inspect final evidence"
            : lastProblemState
              ? `Inspect ${lastProblemState.name}`
              : "Inspect evidence"
  return {
    runStatus: evidence.status,
    activeState,
    openInboxCount,
    lastProblemState,
    returnEvents,
    nextAction,
  }
}

function reviewReturnEvents(evidence: WorkflowEvidence) {
  const semanticReviewStateIds = new Set(
    evidence.state_attempt_summaries
      .filter((attempt) => attempt.kind === "semantic_review")
      .map((attempt) => attempt.state_id),
  )
  return evidence.states.flatMap((state, index) => {
    const nextState = evidence.states[index + 1]
    if (!nextState || !semanticReviewStateIds.has(state.id) || state.status !== "failed" || nextState.name === state.name) {
      return []
    }
    return [{ fromState: state, toState: nextState }]
  })
}

function isProblemStatus(status: string) {
  return status === "failed" || status === "blocked" || status === "timed_out"
}

function stateDurationMs(state: WorkflowStateRecord): number | undefined {
  if (!state.started_at || !state.finished_at) return undefined
  const startedAt = Date.parse(state.started_at)
  const finishedAt = Date.parse(state.finished_at)
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return undefined
  return finishedAt - startedAt
}

function isOutputArtifactKind(kind: string) {
  return kind.endsWith("_output")
}

function artifactDisplayContent(
  artifact: { content: string } | undefined,
): string | undefined {
  if (!artifact) return undefined
  return artifact.content
}

function artifactDisplayTitle(kind: string) {
  if (kind === "worktree_patch") return "Final diff"
  return kind
}

function artifactDisplayDescription(kind: string) {
  if (kind === "worktree_patch") {
    return "Patch captured from the isolated worktree after the workflow stopped."
  }
  return undefined
}

function artifactDisplayPath(artifact: WorkflowEvidence["artifacts"][number]) {
  if (artifact.kind === "worktree_patch") return undefined
  return artifact.path
}


function MermaidDiagram({ source }: { source: string }) {
  const diagramId = `tychonic-mermaid-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
        })
        return mermaid.render(diagramId, source)
      })
      .then(({ svg }) => {
        if (cancelled) return
        setError(undefined)
        if (containerRef.current) {
          containerRef.current.innerHTML = svg
        }
      })
      .catch((renderError: unknown) => {
        if (cancelled) return
        if (containerRef.current) {
          containerRef.current.innerHTML = ""
        }
        setError(renderError instanceof Error ? renderError.message : String(renderError))
      })
    return () => {
      cancelled = true
    }
  }, [diagramId, source])

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>Mermaid render failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="overflow-hidden rounded-md border bg-muted/20 p-3">
      <div
        ref={containerRef}
        aria-label="Workflow definition Mermaid diagram"
        className="min-h-[240px] min-w-0 [&_svg]:h-auto [&_svg]:max-w-full lg:min-h-[320px]"
        role="img"
      />
    </div>
  )
}

function emptyPanel(Icon: ComponentType, title: string, description: string) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent />
    </Empty>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function formatDatePrecise(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
}

function formatRelativeTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return formatDate(value)
}

function projectName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const segments = cwd.replace(/\/+$/, "").split("/")
  return segments[segments.length - 1] || undefined
}

function formatTimePrecise(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

export default App
