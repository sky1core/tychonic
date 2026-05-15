import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react"
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ClockIcon,
  FileTextIcon,
  InboxIcon,
  ListRestartIcon,
  RefreshCcwIcon,
  SearchXIcon,
  TerminalIcon,
  TimerIcon,
  UserRoundIcon,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

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
    resultError?: string
  }
  evidence?: WorkflowEvidence
  evidenceError?: string
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

const inboxStatusTone: Record<string, BadgeTone> = {
  open: "destructive",
  pending: "default",
  waiting: "default",
  waiting_user: "default",
  resolved: "secondary",
  closed: "secondary",
  dismissed: "outline",
}

function App() {
  const selectedRunRef = useRef<{ workflowId?: string; runId?: string }>({})
  const detailRequestSeqRef = useRef(0)
  const selectedStateRunRef = useRef<string | undefined>(undefined)
  const [workflowList, setWorkflowList] = useState<WorkflowList>()
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>()
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [selectedStateId, setSelectedStateId] = useState<string>()
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail>()
  const [activeView, setActiveView] = useState<"runs" | "detail">("runs")
  const [listLoading, setListLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string>()
  const selectedWorkflow = workflowList?.workflows.find(
    (workflow) => workflow.workflowId === selectedWorkflowId && workflow.runId === selectedRunId,
  )

  function applySelection(selection: { workflowId: string; runId: string } | undefined) {
    const previous = selectedRunRef.current
    if (previous.workflowId !== selection?.workflowId || previous.runId !== selection?.runId) {
      detailRequestSeqRef.current += 1
      setWorkflowDetail(undefined)
    }
    selectedRunRef.current = selection ?? {}
    setSelectedWorkflowId(selection?.workflowId)
    setSelectedRunId(selection?.runId)
  }

  async function loadWorkflows(nextSelection?: { workflowId: string; runId: string }, reloadCurrentDetail = false) {
    setListLoading(true)
    setError(undefined)
    try {
      const response = await fetch("/api/workflows?limit=30")
      const body = (await response.json()) as WorkflowList
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? `workflow list request failed with ${response.status}`)
      }
      setWorkflowList(body)
      const explicitSelection = nextSelection
      const currentRunSelection = selectedRunRef.current
      const currentSelection =
        currentRunSelection.workflowId && currentRunSelection.runId
          ? { workflowId: currentRunSelection.workflowId, runId: currentRunSelection.runId }
          : undefined
      const currentSelectionInList = currentSelection
        ? body.workflows.some(
            (workflow) =>
              workflow.workflowId === currentSelection.workflowId && workflow.runId === currentSelection.runId,
          )
        : false
      const next =
        explicitSelection ??
        (currentSelectionInList ? currentSelection : undefined)
      const selectionChanged = next?.workflowId !== currentSelection?.workflowId || next?.runId !== currentSelection?.runId
      applySelection(next)
      if (!next) {
        setWorkflowDetail(undefined)
        setDetailLoading(false)
        setActiveView("runs")
      } else if (reloadCurrentDetail && !selectionChanged) {
        await loadWorkflowDetail(next.workflowId, next.runId)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setListLoading(false)
    }
  }

  async function loadWorkflowDetail(workflowId: string, runId: string) {
    const requestSeq = detailRequestSeqRef.current + 1
    detailRequestSeqRef.current = requestSeq
    setDetailLoading(true)
    setError(undefined)
    setWorkflowDetail((current) =>
      current?.request.workflowId === workflowId && current.request.runId === runId ? current : undefined,
    )
    try {
      const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}?runId=${encodeURIComponent(runId)}`)
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
      if (detailRequestSeqRef.current === requestSeq) {
        setDetailLoading(false)
      }
    }
  }

  useEffect(() => {
    let active = true
    void (async () => {
      setListLoading(true)
      setError(undefined)
      try {
        const response = await fetch("/api/workflows?limit=30")
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

  const workflowDetailWorkflowId = workflowDetail?.request.workflowId
  const workflowDetailRunId = workflowDetail?.request.runId
  const workflowDetailStates = workflowDetail?.evidence?.states
  const workflowDefinitionStates = workflowDetail?.workflowGraph?.definition.states

  useEffect(() => {
    const runKey = workflowDetailWorkflowId && workflowDetailRunId ? `${workflowDetailWorkflowId}:${workflowDetailRunId}` : undefined
    const states = workflowDetailStates ?? []
    const definitionStateNames = workflowDefinitionStates?.map((state) => state.name)
    const selectableStateNames =
      states.length > 0
        ? states.map((state) => state.id)
        : definitionStateNames && definitionStateNames.length > 0
          ? definitionStateNames
          : []
    const runChanged = selectedStateRunRef.current !== runKey
    selectedStateRunRef.current = runKey
    if (!runKey || selectableStateNames.length === 0) {
      setSelectedStateId(undefined)
      return
    }
    setSelectedStateId((current) => {
      if (!runChanged && current && selectableStateNames.includes(current)) {
        return current
      }
      const latestExecuted = [...states]
        .reverse()
        .find((state) => selectableStateNames.includes(state.id))
      return latestExecuted ? latestExecuted.id : selectableStateNames[0]
    })
  }, [workflowDetailWorkflowId, workflowDetailRunId, workflowDetailStates, workflowDefinitionStates])

  const stateGraph = useMemo(
    () => executionStateGraph(workflowDetail?.evidence?.states ?? []),
    [workflowDetail],
  )
  const definitionGraph = useMemo(
    () => definitionStateGraph(workflowDetail?.workflowGraph?.definition, workflowDetail?.evidence?.states ?? []),
    [workflowDetail],
  )
  const stateGraphHeight = workflowGraphViewportHeight(stateGraph.nodes.length)
  const definitionGraphHeight = workflowGraphViewportHeight(definitionGraph.nodes.length)
  const selectedState = useMemo(
    () => latestStateRecordByNameOrId(workflowDetail?.evidence?.states ?? [], selectedStateId),
    [selectedStateId, workflowDetail],
  )
  const selectedDefinitionState = useMemo(
    () => workflowDetail?.workflowGraph?.definition.states.find((state) => state.name === (selectedState?.name ?? selectedStateId)),
    [selectedStateId, selectedState, workflowDetail],
  )
  const runSummary = useMemo(
    () => workflowDetail?.evidence ? workflowRunSummary(workflowDetail.evidence) : undefined,
    [workflowDetail],
  )
  const reviewReturns = useMemo(
    () => workflowDetail?.evidence ? reviewReturnEvents(workflowDetail.evidence) : [],
    [workflowDetail],
  )
  const workflows = useMemo(() => workflowList?.workflows ?? [], [workflowList])
  const onStateNodeClick: NodeMouseHandler = (_, node) => {
    setSelectedStateId(node.id)
  }
  function openWorkflow(workflow: WorkflowSummary) {
    const currentSelection = selectedRunRef.current
    const sameSelection = currentSelection.workflowId === workflow.workflowId && currentSelection.runId === workflow.runId
    applySelection({ workflowId: workflow.workflowId, runId: workflow.runId })
    setActiveView("detail")
    if (sameSelection) {
      void loadWorkflowDetail(workflow.workflowId, workflow.runId)
    }
  }

  return (
    <TooltipProvider>
      <main className="grid min-h-dvh grid-rows-[auto_1fr] bg-background text-foreground">
        <header className="border-b bg-card">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-6">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="truncate text-xl font-semibold">Tychonic Workflows</h1>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{workflowList ? workflowList.address : "Temporal connection pending"}</span>
                {workflowList ? <Badge variant="outline">{workflowList.taskQueue}</Badge> : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={() => void loadWorkflows(undefined, true)}
                    disabled={listLoading || detailLoading}
                  >
                    <RefreshCcwIcon data-icon="inline-start" />
                    Refresh
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reload workflow list and selected evidence</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        <section
          className={cn(
            "mx-auto w-full max-w-7xl px-4 py-4 md:px-6",
            activeView === "detail" ? "grid grid-cols-1 gap-4 md:grid-cols-[360px_minmax(0,1fr)]" : "flex flex-col gap-4",
          )}
        >
          {activeView === "runs" ? (
            <>
              {error ? (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Status UI error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle>Recent Runs</CardTitle>
                  <CardDescription>{workflowList ? `${workflowList.workflows.length} workflows` : "Loading workflows"}</CardDescription>
                </CardHeader>
                <CardContent>
                  {listLoading ? (
                    <div className="flex flex-col gap-3">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  ) : workflowList && workflows.length === 0 ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <SearchXIcon />
                        </EmptyMedia>
                        <EmptyTitle>No workflows</EmptyTitle>
                        <EmptyDescription>Temporal did not return Tychonic workflow executions.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : !workflowList ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <AlertCircleIcon />
                        </EmptyMedia>
                        <EmptyTitle>Workflow list unavailable</EmptyTitle>
                        <EmptyDescription>Check the status UI error above, then refresh the workflow list.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <ScrollArea className="h-[calc(100dvh-260px)] min-h-[420px]">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Execution</TableHead>
                            <TableHead>Workflow</TableHead>
                            <TableHead>Task Queue</TableHead>
                            <TableHead>Started</TableHead>
                            <TableHead>Duration</TableHead>
                            <TableHead>History</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {workflows.map((workflow) => (
                            <TableRow key={`${workflow.workflowId}:${workflow.runId}`}>
                              <TableCell className="w-[150px]">{statusBadgeCell(workflow.status)}</TableCell>
                              <TableCell className="max-w-[420px]">
                                <Button
                                  variant="ghost"
                                  className="h-auto w-full justify-start px-2 py-2 text-left"
                                  onClick={() => openWorkflow(workflow)}
                                >
                                  <div className="flex min-w-0 flex-col gap-1">
                                    <span className="truncate font-medium">{workflow.type}</span>
                                    <span className="truncate text-xs text-muted-foreground">{workflow.workflowId}</span>
                                  </div>
                                </Button>
                              </TableCell>
                              <TableCell>{workflow.taskQueue}</TableCell>
                              <TableCell>{formatDate(workflow.startTime)}</TableCell>
                              <TableCell>{formatWorkflowDuration(workflow)}</TableCell>
                              <TableCell>{workflow.historyLength !== undefined ? workflow.historyLength : "not reported"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <>
              <Card className="min-h-[420px]">
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle>Recent Runs</CardTitle>
                      <CardDescription>{workflowList ? `${workflowList.workflows.length} workflows` : "Loading workflows"}</CardDescription>
                    </div>
                    <Button variant="outline" onClick={() => setActiveView("runs")}>
                      <ArrowLeftIcon data-icon="inline-start" />
                      Runs
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {listLoading ? (
                    <div className="flex flex-col gap-3">
                      <Skeleton className="h-16 w-full" />
                      <Skeleton className="h-16 w-full" />
                      <Skeleton className="h-16 w-full" />
                    </div>
                  ) : workflowList && workflowList.workflows.length === 0 ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <SearchXIcon />
                        </EmptyMedia>
                        <EmptyTitle>No workflows</EmptyTitle>
                        <EmptyDescription>Temporal did not return Tychonic workflow executions.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <ScrollArea className="h-[calc(100dvh-260px)] min-h-[320px]">
                      <div className="flex flex-col gap-2 pr-3">
                        {workflowList?.workflows.map((workflow) => {
                          const selected = workflow.workflowId === selectedWorkflowId && workflow.runId === selectedRunId
                          return (
                            <Button
                              key={`${workflow.workflowId}:${workflow.runId}`}
                              variant={selected ? "secondary" : "ghost"}
                              className="h-auto justify-start px-3 py-3 text-left"
                              onClick={() => openWorkflow(workflow)}
                            >
                              <div className="flex min-w-0 flex-1 flex-col gap-2">
                                <div className="flex min-w-0 items-center justify-between gap-2">
                                  <span className="truncate font-medium">{workflow.type}</span>
                                  <Badge variant={statusTone[workflow.status] ?? "outline"}>{workflow.status}</Badge>
                                </div>
                                <span className="truncate text-xs text-muted-foreground">{workflow.workflowId}</span>
                                <span className="text-xs text-muted-foreground">{formatDate(workflow.startTime)}</span>
                              </div>
                            </Button>
                          )
                        })}
                      </div>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>

              <div className="flex min-w-0 flex-col gap-4">
            {error ? (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>Status UI error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {!selectedWorkflow ? (
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
                <Card>
                  <CardHeader>
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="flex min-w-0 flex-col gap-2">
                        <CardTitle className="truncate">Run status</CardTitle>
                        <CardDescription className="truncate">{selectedWorkflow.workflowId}</CardDescription>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {statusBadgeCell(workflowDetail?.workflow.status ?? selectedWorkflow.status)}
                        {workflowDetail?.evidence ? (
                          <Badge variant={statusTone[workflowDetail.evidence.status] ?? "outline"}>
                            {workflowDetail.evidence.status}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {detailLoading ? (
                      <div className="flex flex-col gap-3">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-[420px] w-full" />
                      </div>
                    ) : (
                      <div className="flex min-w-0 flex-col gap-4">
                        <div className="rounded-md border p-4">
                          <div className="flex min-w-0 flex-col gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={statusTone[runSummary?.runStatus ?? workflowDetail?.evidence?.status ?? ""] ?? "outline"}>
                                {runSummary?.runStatus ?? workflowDetail?.evidence?.status ?? "no evidence"}
                              </Badge>
                              {runSummary?.activeState ? (
                                <Badge variant={statusTone[runSummary.activeState.status] ?? "outline"}>
                                  {runSummary.activeState.name} / {runSummary.activeState.status}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {workflowDetail?.evidence?.summary !== undefined
                                ? workflowDetail.evidence.summary
                                : workflowDetail?.workflow.resultError !== undefined
                                  ? workflowDetail.workflow.resultError
                                  : "No workflow evidence summary is available yet."}
                            </p>
                            <div className="grid gap-2 sm:grid-cols-3">
                              <div className="rounded-md border p-2">
                                <div className="text-xs text-muted-foreground">next action</div>
                                <div className="mt-1 text-sm font-medium">{runSummary?.nextAction ?? "Select a run"}</div>
                              </div>
                              <div className="rounded-md border p-2">
                                <div className="text-xs text-muted-foreground">review returns</div>
                                <div className="mt-1 text-sm font-medium">
                                  {reviewReturns.length > 0
                                    ? `${reviewReturns.length} observed`
                                    : "none observed"}
                                </div>
                              </div>
                              <div className="rounded-md border p-2">
                                <div className="text-xs text-muted-foreground">open inbox</div>
                                <div className="mt-1 text-sm font-medium">{runSummary?.openInboxCount ?? 0}</div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {reviewReturns.length > 0 ? (
                          <div className="rounded-md border p-3">
                            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                              <ListRestartIcon />
                              Review return path
                            </div>
                            <div className="flex flex-col gap-2">
                              {reviewReturns.slice(-3).map((event) => (
                                <div key={`${event.fromState.id}:${event.toState.id}`} className="flex flex-wrap items-center gap-2 text-sm">
                                  <Badge variant="destructive">{event.fromState.name} failed</Badge>
                                  <span className="text-muted-foreground">returned to</span>
                                  <Badge variant={statusTone[event.toState.status] ?? "outline"}>
                                    {event.toState.name} / {event.toState.status}
                                  </Badge>
                                  <span className="min-w-0 truncate text-xs text-muted-foreground">{event.fromState.reason}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        <Separator />

                        <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
                          {workflowDetail?.evidence
                            ? Object.entries(workflowDetail.evidence.counts).map(([key, value]) => (
                                <div key={key} className="rounded-md border px-3 py-2">
                                  <div className="text-xs text-muted-foreground">{key}</div>
                                  <div className="text-lg font-semibold">{value}</div>
                                </div>
                              ))
                            : null}
                        </div>

                        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_300px]">
                          <Tabs defaultValue="execution" className="min-w-0">
                            <TabsList className="flex h-auto flex-wrap justify-start">
                              <TabsTrigger value="execution">Execution path</TabsTrigger>
                              <TabsTrigger value="definition">Definition graph</TabsTrigger>
                            </TabsList>
                            <TabsContent value="execution">
                              {stateGraph.nodes.length > 0 ? (
                                <div className="min-w-0 overflow-hidden rounded-md border" style={{ height: stateGraphHeight }}>
                                  <ReactFlow
                                    nodes={stateGraph.nodes}
                                    edges={stateGraph.edges}
                                    edgeTypes={graphEdgeTypes}
                                    onNodeClick={onStateNodeClick}
                                    nodesConnectable={false}
                                    nodesDraggable={false}
                                    fitView
                                    fitViewOptions={{ padding: 0.08 }}
                                  >
                                    <Background />
                                    <Controls showInteractive={false} />
                                  </ReactFlow>
                                </div>
                              ) : (
                                <div className="rounded-md border">
                                  {emptyPanel(ListRestartIcon, "No execution path", "The workflow has not exposed state records.")}
                                </div>
                              )}
                            </TabsContent>
                            <TabsContent value="definition">
                              {definitionGraph.nodes.length > 0 ? (
                                <div className="min-w-0 overflow-hidden rounded-md border" style={{ height: definitionGraphHeight }}>
                                  <ReactFlow
                                    nodes={definitionGraph.nodes}
                                    edges={definitionGraph.edges}
                                    edgeTypes={graphEdgeTypes}
                                    onNodeClick={onStateNodeClick}
                                    nodesConnectable={false}
                                    nodesDraggable={false}
                                    fitView
                                    fitViewOptions={{ padding: 0.08 }}
                                  >
                                    <Background />
                                    <Controls showInteractive={false} />
                                  </ReactFlow>
                                </div>
                              ) : (
                                <div className="rounded-md border">
                                  {emptyPanel(ListRestartIcon, "No definition graph", "This installed workflow has no YAML definition graph.")}
                                </div>
                              )}
                            </TabsContent>
                          </Tabs>

                          <div className="rounded-md border p-3">
                            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                              <ClockIcon />
                              Selected state
                            </div>
                            {selectedState || selectedDefinitionState ? (
                              <div className="flex min-w-0 flex-col gap-3">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate text-sm">{selectedDefinitionState?.name ?? selectedState?.name}</span>
                                  <Badge variant={statusTone[selectedState?.status ?? "not_run"] ?? "outline"}>
                                    {selectedState?.status ?? selectedDefinitionState?.type}
                                  </Badge>
                                </div>
                                <p className="line-clamp-6 text-xs text-muted-foreground">
                                  {selectedState?.reason ?? "Defined in workflow.yaml; no execution evidence for this state yet."}
                                </p>
                                <Separator />
                                <div className="grid grid-cols-3 gap-2 text-center">
                                  <div className="rounded-md border p-2">
                                    <div className="text-xs text-muted-foreground">attempts</div>
                                    <div className="text-sm font-semibold">{selectedState?.activity_attempt_ids.length ?? 0}</div>
                                  </div>
                                  <div className="rounded-md border p-2">
                                    <div className="text-xs text-muted-foreground">artifacts</div>
                                    <div className="text-sm font-semibold">{selectedState?.artifact_ids.length ?? 0}</div>
                                  </div>
                                  <div className="rounded-md border p-2">
                                    <div className="text-xs text-muted-foreground">findings</div>
                                    <div className="text-sm font-semibold">{selectedState?.finding_ids.length ?? 0}</div>
                                  </div>
                                </div>
                                <div className="grid gap-2 text-xs text-muted-foreground">
                                  {selectedState?.started_at ? (
                                    <div className="flex items-center justify-between gap-2">
                                      <span>started</span>
                                      <span>{formatDate(selectedState.started_at)}</span>
                                    </div>
                                  ) : null}
                                  {selectedState?.finished_at ? (
                                    <div className="flex items-center justify-between gap-2">
                                      <span>finished</span>
                                      <span>{formatDate(selectedState.finished_at)}</span>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            ) : (
                              <p className="text-sm text-muted-foreground">No state selected.</p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Evidence</CardTitle>
                    <CardDescription>Inbox, findings, logs, artifacts, sessions, and timing</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {workflowDetail?.evidenceError ? (
                      <Alert>
                        <AlertCircleIcon />
                        <AlertTitle>Evidence unavailable</AlertTitle>
                        <AlertDescription>{workflowDetail.evidenceError}</AlertDescription>
                      </Alert>
                    ) : workflowDetail?.evidence ? (
                      <Tabs defaultValue="logs">
                        <TabsList className="flex h-auto flex-wrap justify-start">
                          <TabsTrigger value="logs">Logs</TabsTrigger>
                          <TabsTrigger value="findings">Findings</TabsTrigger>
                          <TabsTrigger value="inbox">Inbox</TabsTrigger>
                          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
                          <TabsTrigger value="sessions">Sessions</TabsTrigger>
                          <TabsTrigger value="timing">Timing</TabsTrigger>
                          <TabsTrigger value="definition">Definition</TabsTrigger>
                        </TabsList>
                        <TabsContent value="inbox">
                          {workflowDetail.evidence.inbox.length === 0 ? (
                            emptyPanel(InboxIcon, "No inbox items", "There are no open or historical decision items.")
                          ) : (
                            simpleTable(
                              ["Status", "Title", "Created"],
                              workflowDetail.evidence.inbox.map((item) => [
                                inboxStatusBadgeCell(item.status),
                                textCell(item.title, item.detail),
                                formatDate(item.created_at),
                              ]),
                            )
                          )}
                        </TabsContent>
                        <TabsContent value="findings">
                          {workflowDetail.evidence.findings.length === 0 ? (
                            emptyPanel(AlertCircleIcon, "No findings", "The evidence view has no recorded findings.")
                          ) : (
                            simpleTable(
                              ["Severity", "Title", "Target"],
                              workflowDetail.evidence.findings.map((finding) => [
                                findingSeverityBadgeCell(finding.severity),
                                textCell(finding.title, finding.detail),
                                finding.target !== undefined ? finding.target : "not reported",
                              ]),
                            )
                          )}
                        </TabsContent>
                        <TabsContent value="logs">
                          {workflowDetail.evidence.logs.length === 0 ? (
                            emptyPanel(TerminalIcon, "No logs", "No live output attempts are attached.")
                          ) : (
                            simpleTable(
                              ["State", "Status", "Command"],
                              workflowDetail.evidence.logs.map((log) => [
                                log.state_name !== undefined ? log.state_name : log.kind,
                                statusBadgeCell(log.status),
                                textCell(log.reason, log.read_command),
                              ]),
                            )
                          )}
                        </TabsContent>
                        <TabsContent value="artifacts">
                          {workflowDetail.evidence.artifacts.length === 0 ? (
                            emptyPanel(FileTextIcon, "No artifacts", "No artifacts are attached to this workflow.")
                          ) : (
                            simpleTable(
                              ["Kind", "Path", "Read"],
                              workflowDetail.evidence.artifacts.map((artifact) => [
                                artifact.kind,
                                artifact.path,
                                artifact.read_command,
                              ]),
                            )
                          )}
                        </TabsContent>
                        <TabsContent value="sessions">
                          {workflowDetail.evidence.sessions.length === 0 ? (
                            emptyPanel(UserRoundIcon, "No sessions", "No agent sessions are attached.")
                          ) : (
                            simpleTable(
                              ["Agent", "Role", "Status"],
                              workflowDetail.evidence.sessions.map((session) => [
                                session.agent,
                                session.role,
                                statusBadgeCell(session.status),
                              ]),
                            )
                          )}
                        </TabsContent>
                        <TabsContent value="timing">
                          {simpleTable(
                            ["Kind", "Count", "Duration"],
                            workflowDetail.evidence.timing.by_kind.map((timing) => [
                              timing.kind,
                              String(timing.count),
                              formatDuration(timing.duration_ms),
                            ]),
                          )}
                          <Separator className="my-4" />
                          {workflowDetail.evidence.timing.slowest_attempts.length === 0
                            ? emptyPanel(TimerIcon, "No completed attempts", "Timing is available after attempts finish.")
                            : simpleTable(
                                ["Attempt", "Status", "Duration"],
                                workflowDetail.evidence.timing.slowest_attempts.map((attempt) => [
                                  attempt.state_name !== undefined ? attempt.state_name : attempt.kind,
                                  statusBadgeCell(attempt.status),
                                  formatDuration(attempt.duration_ms),
                                ]),
                              )}
                        </TabsContent>
                        <TabsContent value="definition">
                          {workflowDetail.workflowGraphError ? (
                            <Alert>
                              <AlertCircleIcon />
                              <AlertTitle>Definition graph unavailable</AlertTitle>
                              <AlertDescription>{workflowDetail.workflowGraphError}</AlertDescription>
                            </Alert>
                          ) : workflowDetail.workflowGraph ? (
                            <MermaidDiagram source={workflowDetail.workflowGraph.mermaid} />
                          ) : (
                            emptyPanel(ListRestartIcon, "No definition graph", "This installed workflow has no generated Mermaid graph.")
                          )}
                        </TabsContent>
                      </Tabs>
                    ) : (
                      emptyPanel(ListRestartIcon, "No evidence snapshot", "The workflow has not exposed a Tychonic result yet.")
                    )}
                  </CardContent>
                </Card>
              </>
            )}
              </div>
            </>
          )}
        </section>
      </main>
    </TooltipProvider>
  )
}

function statusBadgeCell(value: string) {
  return <Badge variant={statusTone[value] ?? "outline"}>{value}</Badge>
}

function findingSeverityBadgeCell(value: string) {
  return <Badge variant={findingSeverityTone[value.toLowerCase()] ?? "outline"}>{value}</Badge>
}

function inboxStatusBadgeCell(value: string) {
  return <Badge variant={inboxStatusTone[value.toLowerCase()] ?? "outline"}>{value}</Badge>
}

function formatWorkflowDuration(workflow: WorkflowSummary) {
  if (!workflow.closeTime) return "open"
  const startMs = Date.parse(workflow.startTime)
  const closeMs = Date.parse(workflow.closeTime)
  if (!Number.isFinite(startMs) || !Number.isFinite(closeMs) || closeMs < startMs) return "not reported"
  return formatDuration(closeMs - startMs)
}

function workflowRunSummary(evidence: WorkflowEvidence) {
  const activeState =
    evidence.states.findLast((state) => state.status === "running" || state.status === "blocked" || state.status === "timed_out") ??
    evidence.latest_state ??
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

type StateGraphNode = Node<{ label: ReactNode }>
type StateTone = "running" | "succeeded" | "failed" | "neutral"
type OutcomeEdgeData = {
  outcome?: "start" | "pass" | "fail" | "sequence"
  offset?: number
  tone?: StateTone
}

const graphEdgeTypes = {
  outcome: OutcomeEdge,
}

function workflowGraphViewportHeight(nodeCount: number) {
  return Math.min(860, Math.max(520, nodeCount * 118))
}

function OutcomeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  label,
  data,
}: EdgeProps<Edge<OutcomeEdgeData>>) {
  const offset = typeof data?.offset === "number" ? data.offset : 0
  const edgeClassName = cn(
    "tychonic-state-edge",
    data?.outcome === "fail" ? "tychonic-state-edge-failed" : undefined,
    data?.tone ? `tychonic-state-edge-${data.tone}` : undefined,
  )
  const edgeSourceX = sourceX + offset
  const edgeTargetX = targetX + offset
  const midY = sourceY + (targetY - sourceY) / 2
  const path = `M ${edgeSourceX} ${sourceY} C ${edgeSourceX} ${midY} ${edgeTargetX} ${midY} ${edgeTargetX} ${targetY}`
  const labelX = edgeSourceX + (edgeTargetX - edgeSourceX) / 2
  const labelY = midY

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={edgeClassName} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded-sm border bg-background px-1.5 py-0.5 text-xs font-medium text-muted-foreground shadow-sm"
            style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

function definitionStateGraph(definition: WorkflowDefinitionGraph | undefined, states: WorkflowStateRecord[]): { nodes: StateGraphNode[]; edges: Edge[] } {
  if (!definition) return { nodes: [], edges: [] }

  const stateNames = new Set(definition.states.map((state) => state.name))
  const latestStates = latestStateRecordsByName(states)
  const graphX = 220
  const rowHeight = 150
  const stateNodes = definition.states.map((state, index) => {
    const latestState = latestStates.get(state.name)
    return {
      id: state.name,
      type: "default",
      position: { x: graphX, y: (index + 1) * rowHeight },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      className: cn("tychonic-state-node", `tychonic-state-node-${stateToneClass(latestState?.status ?? "not_run")}`),
      data: {
        label: (
          <div className="flex min-w-0 flex-col gap-1 text-left">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">{index + 1}</span>
              <span className="truncate text-sm font-medium">{state.name}</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {state.type}
              {latestState ? ` / ${latestState.status}` : ""}
            </span>
          </div>
        ),
      },
    } satisfies StateGraphNode
  })
  const nodes: StateGraphNode[] = [
    {
      id: "__start",
      type: "input",
      position: { x: graphX, y: 0 },
      sourcePosition: Position.Bottom,
      className: "tychonic-state-node tychonic-state-node-neutral",
      data: { label: <span className="text-sm font-medium">start</span> },
    },
    ...stateNodes,
    {
      id: "__finish",
      type: "output",
      position: { x: graphX, y: (definition.states.length + 1) * rowHeight },
      targetPosition: Position.Top,
      className: "tychonic-state-node tychonic-state-node-neutral",
      data: { label: <span className="text-sm font-medium">finish</span> },
    },
  ]
  const edges: Edge[] = [
    {
      id: "__start:pass:start",
      source: "__start",
      target: definition.start,
      type: "outcome",
      markerEnd: { type: MarkerType.ArrowClosed },
      className: "tychonic-state-edge",
      data: { outcome: "start", offset: 0 },
    },
    ...definition.edges.flatMap((edge) => {
      const target = edge.finish ? "__finish" : edge.to
      if (!target || (!edge.finish && !stateNames.has(target))) return []
      return [
        {
          id: edge.id,
          source: edge.from,
          target,
          type: "outcome",
          label: edge.label,
          markerEnd: { type: MarkerType.ArrowClosed },
          className: cn("tychonic-state-edge", edge.label === "fail" ? "tychonic-state-edge-failed" : undefined),
          data: { outcome: edge.label, offset: edge.label === "fail" ? 92 : -92 },
        } satisfies Edge,
      ]
    }),
  ]
  return { nodes, edges }
}

function executionStateGraph(states: WorkflowStateRecord[]): { nodes: StateGraphNode[]; edges: Edge[] } {
  const graphX = 220
  const rowHeight = 130
  const nodes = states.map((state, index) => {
    return {
      id: state.id,
      type: "default",
      position: { x: graphX, y: index * rowHeight },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      className: cn("tychonic-state-node", `tychonic-state-node-${stateToneClass(state.status)}`),
      data: {
        label: (
          <div className="flex min-w-0 flex-col gap-1 text-left">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">{index + 1}</span>
              <span className="truncate text-sm font-medium">{state.name}</span>
            </div>
            <span className="text-xs text-muted-foreground">{state.status}</span>
          </div>
        ),
      },
    } satisfies StateGraphNode
  })
  const edges = states.slice(1).map((state, index) => {
    const previous = states[index]
    return {
      id: `${previous.id}:${state.id}:${index}`,
      source: previous.id,
      target: state.id,
      type: "outcome",
      markerEnd: { type: MarkerType.ArrowClosed },
      className: cn("tychonic-state-edge", `tychonic-state-edge-${stateToneClass(state.status)}`),
      animated: state.status === "running",
      data: { outcome: "sequence", offset: 0, tone: stateToneClass(state.status) },
    } satisfies Edge
  })
  return { nodes, edges }
}

function latestStateRecordsByName(states: WorkflowStateRecord[]): Map<string, WorkflowStateRecord> {
  return new Map(states.map((state) => [state.name, state]))
}

function latestStateRecordByNameOrId(states: WorkflowStateRecord[], nameOrId: string | undefined): WorkflowStateRecord | undefined {
  if (!nameOrId) return undefined
  const byName = latestStateRecordsByName(states).get(nameOrId)
  return byName ?? states.find((state) => state.id === nameOrId)
}

function stateToneClass(status: string): StateTone {
  if (status === "succeeded" || status === "COMPLETED") return "succeeded"
  if (status === "failed" || status === "blocked" || status === "timed_out" || status === "FAILED") return "failed"
  if (status === "running" || status === "RUNNING") return "running"
  return "neutral"
}

function textCell(title: string, detail: string) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate">{title}</span>
      <span className="line-clamp-2 text-xs text-muted-foreground">{detail}</span>
    </div>
  )
}

function simpleTable(headers: string[], rows: Array<Array<ReactNode>>) {
  return (
    <ScrollArea className="h-[360px]">
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((header) => (
              <TableHead key={header}>{header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <TableCell key={`${rowIndex}:${cellIndex}`} className={cn(cellIndex === 0 ? "w-[140px]" : "max-w-[520px]")}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  )
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
    <div className="overflow-auto rounded-md border bg-muted/20 p-3">
      <div
        ref={containerRef}
        aria-label="Workflow definition Mermaid diagram"
        className="min-h-[320px] min-w-[640px]"
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

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

export default App
