import type { BridgeStatus, HistoricalTask, HistoryResult, HistoryTurn, MemoryWriteNotice, SessionNotice, TaskWork } from "../../shared/ipc";
import type { DagActivity, DagHeartbeat, DagRun, LiveTask, TodoPhase, WireGoal } from "../../shared/protocol";
import type {
  CommandApprovalParams,
  FileChangeApprovalParams,
  Model,
  ReasoningEffort,
  RequestId,
  RpcNotification,
  RpcServerRequest,
  SkillErrorInfo,
  SkillMetadata,
  Thread,
  ThreadItem,
  ThreadStatus,
  TurnError,
  TurnStatus,
  UserInputParams,
} from "../../shared/protocol";

export interface ThreadSummary {
  id: string;
  cwd: string;
  name: string | null;
  preview: string;
  /** Unix milliseconds. */
  updatedAt: number;
  status: ThreadStatus;
  path: string | null;
  source: string | null;
}

/** The model omo reported for a thread in its thread/start or thread/resume result. */
export interface SessionModel {
  modelProvider: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

export interface ConversationItem {
  item: ThreadItem;
  streaming: boolean;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface ConversationTurn {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
  items: ConversationItem[];
  startedAtMs: number | null;
  completedAtMs: number | null;
  origin: "live" | "history";
}

export type ImageInput = Extract<import("../../shared/protocol").UserInput, { type: "image" | "localImage" }>;

export interface PendingUserMessage {
  clientId: string;
  text: string;
  images?: readonly ImageInput[];
  sentAtMs: number;
}

export interface Conversation {
  threadId: string;
  historyState: "idle" | "loading" | "loaded" | "error";
  historyError: string | null;
  turns: ConversationTurn[];
  activeTurnId: string | null;
  /** True once this app-server process has loaded the thread through thread/start or thread/resume. */
  resumed: boolean;
  pendingUserMessages: PendingUserMessage[];
  /** The model omo reported in this thread's latest thread/start or thread/resume result. */
  session?: SessionModel;
  live: ThreadLiveState;
  /** Memory writes and omo's special messages read from the session file; refreshed after each completed turn. */
  annotations: SessionAnnotations;
}

export interface SessionAnnotations {
  notices: SessionNotice[];
  memoryWrites: Record<string, MemoryWriteNotice>;
}

export interface ThreadLiveState {
  freshness: "unattached" | "live" | "stale";
  runs: Record<string, DagRun>;
  runOrder: string[];
  truncatedRuns?: number;
  tasks: Record<string, LiveTask>;
  taskOrder: string[];
  truncatedTasks?: number;
  historicalTasks: HistoricalTask[];
  taskWork: TaskWork[];
  dagActivity: Record<string, Record<string, DagActivity>>;
  heartbeat: DagHeartbeat | null;
  goal: WireGoal | null | undefined;
  todo: { phases: TodoPhase[]; source: "history" | "live" } | null;
  diagnostics: number;
  /** Fences reads across reconnects and newer goal/todo observations. */
  generation: number;
  goalRevision: number;
  todoRevision: number;
}

export type PendingRequest =
  | { kind: "commandApproval"; id: RequestId; threadId: string; params: CommandApprovalParams; receivedAtMs: number }
  | { kind: "fileChangeApproval"; id: RequestId; threadId: string; params: FileChangeApprovalParams; receivedAtMs: number }
  | { kind: "userInput"; id: RequestId; threadId: string; params: UserInputParams; receivedAtMs: number };

/** Notices the UI translates by code; a notice without a code shows its message as-is (omo's own error text). */
export type NoticeCode = "noActiveThread" | "steered" | "branchBusy";

export interface Notice {
  id: string;
  level: "info" | "error";
  message: string;
  threadId: string | null;
  code?: NoticeCode;
  /** "side" renders the notice inside the side chat panel of `threadId` (its main thread) instead of as a toast. */
  scope?: "side";
  /** "open-thread" renders an Open action that activates `threadId` (a notification about another thread). */
  action?: "open-thread";
}

export interface ComposerState {
  profile?: import("../../shared/ipc").ModelProfile | null;
  modelId: string | null;
  effort: ReasoningEffort | null;
}

/** One retained /btw side chat of a main thread; the side chat is its own omo thread. */
export interface SideChat {
  /** The side thread id. */
  id: string;
  /** The main thread the side chat was asked from. */
  parentId: string;
  /** The question as typed; the first side message also carries the main thread's background. */
  question: string;
  createdAtMs: number;
  /** Whether the first side message carried the main thread's read-only background. */
  context: boolean;
}

export interface BtwState {
  /** Whether the side chat panel is shown. */
  open: boolean;
  /** Side chats by side thread id. */
  sides: Record<string, SideChat>;
  /** The side chat shown per main thread; null or absent shows the new-side composer. */
  selected: Record<string, string | null>;
  /** Main threads whose next new side chat starts without background (the context chip was removed). */
  detached: Record<string, true>;
  /** Side composer drafts keyed by `sideDraftKey`. */
  drafts: Record<string, string>;
  /** Number of side-chat thread/start requests in flight per cwd. */
  pending: Record<string, number>;
  /** Threads (id → cwd) that thread/started announced while a side start was pending in their cwd and nothing has claimed yet. */
  unclaimed: Record<string, string>;
  /** True once the stored side chats were read; storage is written only after that. */
  restored: boolean;
}

export interface SkillCatalog {
  status: "idle" | "loading" | "ready" | "error";
  skills: SkillMetadata[];
  errors: SkillErrorInfo[];
  generation: number;
  stale: boolean;
}

/** Whether the Agents DAG panel occupies the right-panel column; it and the side chat exclude each other. */
export interface AgentsState {
  open: boolean;
}

export interface AppState {
  mcp: { servers: import("./mcp").McpServer[]; loading: boolean; error: string | null; loadedAt: number | null };
  bridge: BridgeStatus | null;
  models: Model[];
  threads: Record<string, ThreadSummary>;
  /** Thread ids ordered by updatedAt, newest first. */
  threadOrder: string[];
  threadsCursor: string | null;
  threadsLoaded: boolean;
  activeThreadId: string | null;
  conversations: Record<string, Conversation>;
  pendingRequests: PendingRequest[];
  notices: Notice[];
  composer: ComposerState;
  skillCatalogs: Record<string, SkillCatalog>;
  /** Cwds loaded through a successful thread/start or thread/resume in this bridge session. */
  loadedSkillCwds: Record<string, true>;
  /** Monotonic across bridge reconnects to fence responses from the previous process. */
  skillGeneration: number;
  btw: BtwState;
  agents: AgentsState;
}

export type AppEvent =
  | { type: "taskWork/loaded"; threadId: string; work: TaskWork[]; generation: number }
  | { type: "mcp/updated"; mcp: AppState["mcp"] }
  | { type: "bridge/status"; status: BridgeStatus }
  | { type: "rpc/notification"; notification: RpcNotification; receivedAtMs: number }
  | { type: "rpc/serverRequest"; request: RpcServerRequest; receivedAtMs: number }
  | { type: "rpc/serverRequestAnswered"; id: RequestId }
  | { type: "models/loaded"; models: Model[] }
  | { type: "skills/loading"; cwd: string }
  | { type: "skills/loaded"; cwd: string; generation: number; skills: SkillMetadata[]; errors: SkillErrorInfo[] }
  | { type: "skills/failed"; cwd: string; generation: number; message: string }
  | { type: "threads/listed"; threads: Thread[]; nextCursor: string | null; append: boolean }
  | { type: "thread/opened"; thread: Thread; resumed: boolean; session?: SessionModel }
  | { type: "thread/activated"; threadId: string | null }
  | { type: "history/loading"; threadId: string }
  | { type: "history/loaded"; threadId: string; turns: HistoryTurn[]; todo?: HistoryResult["todo"]; tasks?: HistoricalTask[]; notices?: SessionNotice[]; memoryWrites?: Record<string, MemoryWriteNotice> }
  | { type: "history/annotated"; threadId: string; notices: SessionNotice[]; memoryWrites: Record<string, MemoryWriteNotice> }
  | { type: "goal/loaded"; threadId: string; goal: WireGoal | null; generation: number; revision: number }
  | { type: "todo/loaded"; threadId: string; todo: HistoryResult["todo"]; generation: number; revision: number }
  | { type: "history/failed"; threadId: string; message: string }
  | { type: "turn/errorReconciled"; threadId: string; turn: ConversationTurn; error: TurnError }
  /** omo no longer runs the thread's active turn (a steer or interrupt was rejected); the turn ends as `status` locally. */
  | { type: "turn/settled"; threadId: string; status: "completed" | "interrupted"; settledAtMs: number }
  | { type: "user/messageSent"; threadId: string; clientId: string; text: string; images?: readonly ImageInput[]; sentAtMs: number }
  | { type: "user/messageFailed"; threadId: string; clientId: string; message: string }
  | { type: "composer/modelSelected"; modelId: string | null; effort: ReasoningEffort | null; profile?: import("../../shared/ipc").ModelProfile | null }
  | { type: "notice/pushed"; notice: Notice }
  | { type: "notice/dismissed"; id: string }
  | { type: "btw/restored"; sides: SideChat[] }
  | { type: "btw/toggled"; open: boolean }
  | { type: "btw/selected"; parentId: string; sideId: string | null }
  | { type: "btw/contextSet"; parentId: string; attached: boolean }
  | { type: "btw/draftSet"; key: string; text: string }
  | { type: "btw/starting"; cwd: string }
  | { type: "btw/started"; cwd: string; side: SideChat | null }
  | { type: "agents/toggled"; open: boolean };
