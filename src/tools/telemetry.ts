import { loadObjectXml } from '../indexer/sourceFiles.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import * as dbUtils from '../indexer/db.js';
import { parseAxClassSources, type AxClassSources } from '../indexer/parser.js';
import { fail, ok, type ToolResult } from './generators.js';

/*
 * Query shapes and customDimensions field names follow Microsoft's
 * Dynamics-365-FastTrack-FSCM-Telemetry-Samples (MIT licensed,
 * Copyright (c) Microsoft Corporation).
 */
export const TELEMETRY_ATTRIBUTION =
  'Adapted from Microsoft Dynamics-365-FastTrack-FSCM-Telemetry-Samples (MIT, Copyright (c) Microsoft Corporation).';

const BATCH_PREREQ =
  'Batch telemetry requires 10.0.44 (build 7.0.7606.126+) or 10.0.45 (build 7.0.7690.21+) or later, with batch telemetry ' +
  'enabled in Monitoring and telemetry parameters and an Application Insights connection configured for the environment.';
const APP_INSIGHTS_PREREQ =
  'Requires F&O telemetry exported to Application Insights (Monitoring and telemetry parameters) for the environment.';
const STORE_PREREQ =
  'Requires the Commerce Store Monitoring Agent (Azure Monitor agent) sending the store machines\' Windows events, ' +
  'heartbeat and performance counters to a Log Analytics workspace.';

export type KqlTarget = 'ApplicationInsights' | 'LogAnalytics';

interface ScenarioDef {
  description: string;
  target: KqlTarget;
  prerequisite: string;
  /** Filters the scenario applies; others are ignored with a note. */
  filters: ReadonlyArray<'environmentId' | 'batchJobId' | 'className' | 'computer'>;
  body: string;
}

const ENV = `| where     isempty(_environmentId) or tostring(cd.EnvironmentId) == _environmentId`;
const JOB = `| where     array_length(_batchJobId) == 0 or tostring(cd.BatchJobId) in (_batchJobId)`;
const CLASS = `| where     isempty(_className) or ClassName =~ _className`;
const CD = `| extend    cd = parse_json(customDimensions)`;
const INFO = `| extend    info = parse_json(tostring(cd.InfoMessage))`;
const COMPUTER = `| where     isempty(_computer) or Computer =~ _computer`;

export const KQL_SCENARIOS: Record<string, ScenarioDef> = {
  'batch-failures': {
    description: 'BatchTaskFailure events with exception type, message and call stack (exceptions often missing from the infolog).',
    target: 'ApplicationInsights',
    prerequisite: BATCH_PREREQ,
    filters: ['environmentId', 'batchJobId', 'className'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name == "BatchTaskFailure"
${CD}
${ENV}
${JOB}
| extend    ClassName = iif(tostring(cd.ClassName) == "<empty>", "", tostring(cd.ClassName))
${CLASS}
| project   timestamp, RoleInstance = cloud_RoleInstance, ActivityId = tostring(cd.activityId),
            BatchJobCaption = tostring(cd.BatchJobCaption), ClassName, BatchJobId = tostring(cd.BatchJobId),
            BatchTaskId = tostring(cd.BatchTaskId), EventMessage = tostring(cd.EventMessage),
            ExceptionType = tostring(cd.ExceptionType), ExceptionMessage = tostring(cd.ExceptionMessage),
            CallStack = tostring(cd.CallStack)
| order by  timestamp desc`,
  },
  'batch-failures-over-time': {
    description: 'Count of BatchTaskFailure events per 10 minutes.',
    target: 'ApplicationInsights',
    prerequisite: BATCH_PREREQ,
    filters: ['environmentId', 'batchJobId', 'className'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name == "BatchTaskFailure"
${CD}
${ENV}
${JOB}
| extend    ClassName = tostring(cd.ClassName)
${CLASS}
| summarize TotalFailures = count() by bin(timestamp, 10m)
| order by  timestamp asc`,
  },
  'batch-long-running-tasks': {
    description: 'Batch task executions (start, finish, failure) correlated by activityId, longest elapsed first; unfinished tasks are measured to now().',
    target: 'ApplicationInsights',
    prerequisite: BATCH_PREREQ,
    filters: ['environmentId', 'batchJobId', 'className'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name in ("BatchTaskStart", "BatchTaskFinished", "BatchTaskFailure")
${CD}
${ENV}
${JOB}
${INFO}
| extend    ClassName = tostring(cd.ClassName)
${CLASS}
// Task id field names differ between events.
| extend    BatchTaskId = iif(isnotempty(tostring(cd.BatchJobTaskId)), tostring(cd.BatchJobTaskId), tostring(cd.BatchTaskId))
| extend    StartTime = iff(name == "BatchTaskStart", timestamp, datetime(null)),
            EndTime   = iff(name == "BatchTaskFinished", timestamp, datetime(null)),
            ErrorTime = iff(name == "BatchTaskFailure", timestamp, datetime(null)),
            RetryCount = iff(name == "BatchTaskStart", tostring(info.RetryCount), "")
| summarize StartTime = min(StartTime), CompletionTime = max(EndTime), ErrorTime = max(ErrorTime),
            RetryCount = take_any(RetryCount), ClassName = take_any(ClassName), BatchJobId = take_any(tostring(cd.BatchJobId)),
            BatchTaskId = take_any(BatchTaskId), RoleInstance = take_any(cloud_RoleInstance)
            by ActivityId = tostring(cd.activityId)
| where     isnotempty(StartTime)
| extend    BatchAOS = tostring(split(RoleInstance, "-")[0])
| extend    ElapsedTime = iif(isnotempty(CompletionTime), CompletionTime, now()) - StartTime
| project   ActivityId, BatchAOS, BatchJobId, BatchTaskId, ClassName, StartTime, CompletionTime, ErrorTime, ElapsedTime, RetryCount
| order by  ElapsedTime desc`,
  },
  'batch-throttling': {
    description: 'BatchThrottled events with the machine CPU, memory and SQL DTU that caused throttling (BatchJobId is always 0 on these events).',
    target: 'ApplicationInsights',
    prerequisite: BATCH_PREREQ,
    filters: ['environmentId'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name == "BatchThrottled"
${CD}
${ENV}
${INFO}
| project   timestamp, RoleInstance = cloud_RoleInstance, LegalEntity = tostring(cd.LegalEntity),
            EventMessage = tostring(cd.EventMessage), CurrentMachineCpu = round(toreal(info.CurrentMachineCpu), 0),
            CurrentMachineMemory = info.CurrentMachineMemory, CurrentSqlDtu = info.CurrentSqlDtu
| order by  timestamp desc`,
  },
  'batch-throttled-vs-running': {
    description: 'Throttled versus started batch tasks per 10 minutes.',
    target: 'ApplicationInsights',
    prerequisite: BATCH_PREREQ,
    filters: ['environmentId'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name in ("BatchThrottled", "BatchTaskStart")
${CD}
${ENV}
| summarize ThrottledTasks = countif(name == "BatchThrottled"), RunningTasks = countif(name == "BatchTaskStart") by bin(timestamp, 10m)
| order by  timestamp asc`,
  },
  'batch-thread-availability': {
    description: 'Available batch threads per batch AOS over time (MaxThreadCount - CurrentBatchTasks - ReservedNumberOfThreads).',
    target: 'ApplicationInsights',
    prerequisite: BATCH_PREREQ,
    filters: ['environmentId'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name == "BatchThreadInfo"
${CD}
${ENV}
${INFO}
| project   timestamp, BatchAOS = tostring(split(cloud_RoleInstance, "-")[0]),
            AvailableThreads = todecimal(info.MaxThreadCount) - todecimal(info.CurrentBatchTasks) - todecimal(info.ReservedNumberOfThreads),
            TaskQueueCount = toint(info.TaskQueueCount)
| order by  timestamp asc`,
  },
  'batch-priority-distribution': {
    description: 'Distinct batch tasks started, by scheduling priority (missing priority is reported as Normal).',
    target: 'ApplicationInsights',
    prerequisite: BATCH_PREREQ,
    filters: ['environmentId', 'batchJobId', 'className'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name == "BatchTaskStart"
${CD}
${ENV}
${JOB}
| extend    ClassName = tostring(cd.ClassName)
${CLASS}
| extend    Priority = iif(isnotempty(tostring(cd.Priority)), tostring(cd.Priority), "Normal")
| extend    BatchTaskId = tostring(cd.BatchTaskId)
| distinct  BatchTaskId, Priority
| summarize Tasks = count() by Priority`,
  },
  'batch-queue-sizes': {
    description: 'Batch scheduling queue depth per priority and the ready-tasks buffer over time.',
    target: 'ApplicationInsights',
    prerequisite: BATCH_PREREQ,
    filters: ['environmentId'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name == "BatchQueuesDetails"
${CD}
${ENV}
${INFO}
| project   timestamp,
            Low = toint(info.BatchLowSchedulingQueue), Normal = toint(info.BatchNormalSchedulingQueue),
            High = toint(info.BatchHighSchedulingQueue), Critical = toint(info.BatchCriticalSchedulingQueue),
            ReservedCapacity = toint(info.BatchReservedCapacitySchedulingQueue),
            ReadyTasksBuffer = toint(info.ReadyTasksBuffer), ReadyTasksBufferWithPriorities = toint(info.ReadyTasksBufferWithPriorities)
| order by  timestamp asc`,
  },
  'batch-exceptions': {
    description: 'X++ exceptions raised while running in batch (exceptions table, ExecutionMode == "Batch").',
    target: 'ApplicationInsights',
    prerequisite: APP_INSIGHTS_PREREQ,
    filters: ['environmentId', 'batchJobId', 'className'],
    body: `exceptions
| where     timestamp between (_startTime .. _endTime)
${CD}
| where     tostring(cd.ExecutionMode) == "Batch"
${ENV}
${JOB}
| extend    ClassName = tostring(cd.ClassName)
${CLASS}
| project   timestamp, ActivityId = tostring(cd.activityId), BatchJobId = tostring(cd.BatchJobId),
            BatchJobCaption = tostring(cd.BatchJobCaption), ClassName, MethodName = tostring(cd.MethodName),
            ShortMessage = tostring(split(split(outerMessage, "\\\\")[0], ".")[0]), OuterMessage = outerMessage,
            CallStack = tostring(cd.CallStack)
| order by  timestamp desc`,
  },
  'xpp-exceptions': {
    description: 'X++ exceptions in any execution mode, grouped by class, method and short message.',
    target: 'ApplicationInsights',
    prerequisite: APP_INSIGHTS_PREREQ,
    filters: ['environmentId', 'className'],
    body: `exceptions
| where     timestamp between (_startTime .. _endTime)
${CD}
${ENV}
| extend    ClassName = tostring(cd.ClassName)
${CLASS}
| extend    ShortMessage = tostring(split(split(outerMessage, "\\\\")[0], ".")[0])
| summarize Occurrences = count(), LastSeen = max(timestamp), SampleCallStack = take_any(tostring(cd.CallStack))
            by ExecutionMode = tostring(cd.ExecutionMode), ClassName, MethodName = tostring(cd.MethodName), ShortMessage
| order by  Occurrences desc`,
  },
  'slow-sql': {
    description: 'LongRunningQuery events (slow SQL statements) by query type, slowest first; a class filter matches the call stack.',
    target: 'ApplicationInsights',
    prerequisite: APP_INSIGHTS_PREREQ,
    filters: ['environmentId', 'className'],
    body: `customEvents
| where     timestamp between (_startTime .. _endTime)
| where     name == "LongRunningQuery"
${CD}
${ENV}
| extend    CallStack = tostring(cd.CallStack)
| where     isempty(_className) or CallStack has _className
| project   timestamp, LegalEntity = tostring(cd.LegalEntity), ExecutionMode = tostring(cd.ExecutionMode),
            QueryType = tostring(cd.QueryType), ExecutionTimeSeconds = toreal(cd.ExecutionTimeSeconds),
            JoinCount = toint(cd.JoinCount), ReturnedRowCount = toint(cd.ReturnedRowCount),
            Success = tostring(cd.Success), CallStack
| order by  ExecutionTimeSeconds desc`,
  },
  'store-heartbeat': {
    description: 'Last heartbeat per Commerce store machine; stale machines are offline or not reporting.',
    target: 'LogAnalytics',
    prerequisite: STORE_PREREQ,
    filters: ['computer'],
    body: `Heartbeat
| where     TimeGenerated between (_startTime .. _endTime)
${COMPUTER}
| summarize LastHeartbeat = max(TimeGenerated) by Computer
| extend    MinutesSinceHeartbeat = datetime_diff('minute', now(), LastHeartbeat)
| order by  MinutesSinceHeartbeat desc`,
  },
  'store-commerce-events': {
    description: 'Store Commerce application events (errors and warnings first) from the store machines.',
    target: 'LogAnalytics',
    prerequisite: STORE_PREREQ,
    filters: ['computer'],
    body: `Event
| where     TimeGenerated between (_startTime .. _endTime)
// The Event table stores the Windows event provider in Source.
| where     Source == "Microsoft Dynamics - Store Commerce"
${COMPUTER}
| summarize Occurrences = count(), LastSeen = max(TimeGenerated), SampleMessage = take_any(RenderedDescription)
            by Computer, EventLevelName, EventID
| order by  EventLevelName asc, Occurrences desc`,
  },
  'store-db-metrics': {
    description: 'Store (offline/channel) database metrics reports from DatabaseMetricsService (EventID 3000).',
    target: 'LogAnalytics',
    prerequisite: STORE_PREREQ,
    filters: ['computer'],
    body: `Event
| where     TimeGenerated between (_startTime .. _endTime)
| where     Source == "DatabaseMetricsService" and EventID == 3000
${COMPUTER}
| project   TimeGenerated, Computer, RenderedDescription
| order by  TimeGenerated desc`,
  },
  'store-perf': {
    description: 'Average store machine performance counters per 15 minutes.',
    target: 'LogAnalytics',
    prerequisite: STORE_PREREQ,
    filters: ['computer'],
    body: `Perf
| where     TimeGenerated between (_startTime .. _endTime)
${COMPUTER}
| summarize AvgValue = avg(CounterValue), MaxValue = max(CounterValue) by bin(TimeGenerated, 15m), Computer, ObjectName, CounterName
| order by  TimeGenerated asc`,
  },
};

export const KQL_SCENARIO_NAMES = Object.keys(KQL_SCENARIOS) as [string, ...string[]];

/** KQL single-quoted string literal. */
export function kqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

const TIMESPAN = /^\d{1,4}(d|h|m)$/;

export interface KqlOptions {
  scenario: string;
  timespan?: string;
  startTime?: string;
  endTime?: string;
  environmentId?: string;
  batchJobIds?: string[];
  className?: string;
  computer?: string;
}

export interface KqlQuery {
  scenario: string;
  description: string;
  target: KqlTarget;
  table: string;
  prerequisite: string;
  query: string;
  notes: string[];
  attribution: string;
}

function datetimeLiteral(value: string, label: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${label} is not a valid ISO 8601 date/time: ${value}`);
  return `datetime(${new Date(ms).toISOString()})`;
}

/** Build a parameterized KQL query; throws on invalid input. */
export function buildKqlQuery(opts: KqlOptions): KqlQuery {
  const def = KQL_SCENARIOS[opts.scenario];
  if (!def) throw new Error(`Unknown scenario '${opts.scenario}'. Valid: ${KQL_SCENARIO_NAMES.join(', ')}`);
  const notes: string[] = [];

  const timespan = opts.timespan ?? '7d';
  if (!opts.startTime && !TIMESPAN.test(timespan)) {
    throw new Error(`timespan must look like 7d, 12h or 30m; got '${timespan}'.`);
  }
  const start = opts.startTime ? datetimeLiteral(opts.startTime, 'startTime') : `ago(${timespan})`;
  const end = opts.endTime ? datetimeLiteral(opts.endTime, 'endTime') : 'now()';

  const jobIds = (opts.batchJobIds ?? []).map((id) => id.trim()).filter(Boolean);
  for (const id of jobIds) {
    if (!/^\d+$/.test(id)) throw new Error(`batchJobIds must be numeric RecIds; got '${id}'.`);
  }

  const supplied: Record<string, boolean> = {
    environmentId: !!opts.environmentId,
    batchJobId: jobIds.length > 0,
    className: !!opts.className,
    computer: !!opts.computer,
  };
  for (const [key, given] of Object.entries(supplied)) {
    if (given && !def.filters.includes(key as ScenarioDef['filters'][number])) {
      notes.push(`Filter '${key}' does not apply to scenario '${opts.scenario}' and was ignored.`);
    }
  }

  const lets = [`let _startTime = ${start};`, `let _endTime = ${end};`];
  if (def.filters.includes('environmentId')) lets.push(`let _environmentId = ${kqlString(opts.environmentId ?? '')};`);
  if (def.filters.includes('batchJobId')) lets.push(`let _batchJobId = dynamic([${jobIds.map((id) => `"${id}"`).join(', ')}]);`);
  if (def.filters.includes('className')) lets.push(`let _className = ${kqlString(opts.className ?? '')};`);
  if (def.filters.includes('computer')) lets.push(`let _computer = ${kqlString(opts.computer ?? '')};`);

  const header = `// ${def.description}\n// ${TELEMETRY_ATTRIBUTION}`;
  return {
    scenario: opts.scenario,
    description: def.description,
    target: def.target,
    table: def.body.split('\n', 1)[0].trim(),
    prerequisite: def.prerequisite,
    query: `${header}\n${lets.join('\n')}\n${def.body}`,
    notes,
    attribution: TELEMETRY_ATTRIBUTION,
  };
}

export function generateKqlQuery(db: Database, opts: KqlOptions): ToolResult {
  let result: KqlQuery;
  try {
    result = buildKqlQuery(opts);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (opts.className && KQL_SCENARIOS[opts.scenario].filters.includes('className')) {
    const cls = dbUtils.getObjectByName(db, opts.className, 'Class');
    if (!cls) {
      result.notes.push(
        `Class '${opts.className}' is not in the index; the filter is kept as typed (telemetry may use a class outside the indexed models).`
      );
    }
  }
  return ok(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// analyze_batch_class
// ---------------------------------------------------------------------------

export type BatchFramework =
  | 'RunBaseBatch'
  | 'RunBase'
  | 'SysOperationController'
  | 'SysOperationService'
  | 'SysOperationDataContract'
  | 'Unknown';

export interface BatchFinding {
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface BatchClassAnalysis {
  className: string;
  package: string;
  framework: BatchFramework;
  inheritanceChain: string[];
  chainLeavesIndex: boolean;
  implements: string[];
  batchCapable: boolean | 'unknown';
  retryable: boolean | 'unknown';
  overrides: Record<string, boolean>;
  sourceAvailable: boolean;
  findings: BatchFinding[];
  telemetry: { failures: string; longRunning: string; attribution: string };
}

const OVERRIDES = [
  'canGoBatch', 'canRunInNewSession', 'isRetryable', 'pack', 'unpack', 'dialog', 'getFromDialog',
  'validate', 'run', 'description', 'caption', 'construct', 'main', 'new', 'process', 'initializeFromArgs',
];

const RUNBASE_BATCH = new Set(['runbasebatch']);
const RUNBASE = new Set(['runbase', 'runbasereport']);
const SYSOP_CONTROLLER = new Set(['sysoperationservicecontroller', 'sysoperationcontroller']);
const SYSOP_SERVICE = new Set(['sysoperationservicebase']);
/** Framework classes whose own methods do not count as user overrides. */
const FRAMEWORK_BASES = new Set([...RUNBASE_BATCH, ...RUNBASE, ...SYSOP_CONTROLLER, ...SYSOP_SERVICE, 'object']);

function stripXppComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Literal return of a boolean method body, or null when it is computed/unknown. */
function returnsLiteral(body: string | undefined): boolean | null {
  if (!body) return null;
  const returns = [...stripXppComments(body).matchAll(/\breturn\s+([^;]+);/g)].map((m) => m[1].trim().toLowerCase());
  if (returns.length === 0) return null;
  if (returns.every((r) => r === 'true')) return true;
  if (returns.every((r) => r === 'false')) return false;
  return null;
}

export async function analyzeBatchClass(db: Database, className: string): Promise<BatchClassAnalysis | null> {
  const obj = dbUtils.getObjectByName(db, className, 'Class');
  if (!obj) return null;

  const chain: string[] = [obj.name];
  const implementsSet = new Set<string>();
  const inheritedMethods = new Set<string>();
  let chainLeavesIndex = false;
  let current: any = obj;
  const seen = new Set<string>([obj.name.toLowerCase()]);
  while (current) {
    for (const x of dbUtils.getXrefsFrom(db, current.name, 'Class', 'implements')) implementsSet.add(x.to_name);
    if (current !== obj && !FRAMEWORK_BASES.has(current.name.toLowerCase())) {
      for (const m of current.methods) inheritedMethods.add(String(m.name).toLowerCase());
    }
    const parent = dbUtils.getXrefsFrom(db, current.name, 'Class', 'extends')[0]?.to_name;
    if (!parent || seen.has(parent.toLowerCase())) break;
    seen.add(parent.toLowerCase());
    chain.push(parent);
    current = dbUtils.getObjectByName(db, parent, 'Class');
    if (!current) chainLeavesIndex = true;
  }
  const lowerChain = chain.map((c) => c.toLowerCase());
  const implementsList = [...implementsSet];
  const implementsLower = new Set(implementsList.map((i) => i.toLowerCase()));

  const xml = await loadObjectXml(obj);
  let sources: AxClassSources | null = null;
  if (xml) {
    try {
      sources = parseAxClassSources(xml);
    } catch {
      sources = null;
    }
  }
  const declaration = sources ? stripXppComments(sources.declaration) : '';

  let framework: BatchFramework = 'Unknown';
  if (lowerChain.some((c) => RUNBASE_BATCH.has(c))) framework = 'RunBaseBatch';
  else if (lowerChain.some((c) => SYSOP_CONTROLLER.has(c))) framework = 'SysOperationController';
  else if (lowerChain.some((c) => SYSOP_SERVICE.has(c))) framework = 'SysOperationService';
  else if (lowerChain.some((c) => RUNBASE.has(c))) framework = 'RunBase';
  else if (/\[\s*DataContract(Attribute)?\b/i.test(declaration)) framework = 'SysOperationDataContract';

  const own = new Set<string>(obj.methods.map((m: any) => String(m.name).toLowerCase()));
  const overrides: Record<string, boolean> = {};
  for (const name of OVERRIDES) overrides[name] = own.has(name.toLowerCase());

  const body = (name: string) => sources?.methods.get(name.toLowerCase());
  const findings: BatchFinding[] = [];
  const add = (severity: BatchFinding['severity'], message: string) => findings.push({ severity, message });

  if (chainLeavesIndex) {
    add('info', `Inheritance leaves the index at '${chain[chain.length - 1]}'; framework detection uses the class names only.`);
  }
  if (!sources) add('info', 'Class source is not available (index built without raw XML and the file is not readable); source checks skipped.');

  // Batch capability
  let batchCapable: boolean | 'unknown' = 'unknown';
  const canGoBatch = returnsLiteral(body('canGoBatch'));
  if (framework === 'RunBaseBatch') {
    batchCapable = own.has('cangobatch') ? (canGoBatch ?? 'unknown') : true;
    if (canGoBatch === false) add('warning', 'canGoBatch() returns false: the class extends RunBaseBatch but cannot be scheduled in batch.');
  } else if (framework === 'RunBase') {
    batchCapable = canGoBatch === true;
    add('warning', 'Extends RunBase, not RunBaseBatch: it cannot run in batch. For new work prefer the SysOperation framework.');
  } else if (framework === 'SysOperationController') {
    batchCapable = own.has('cangobatch') ? (canGoBatch ?? 'unknown') : true;
    if (canGoBatch === false) add('warning', 'canGoBatch() returns false: the controller cannot be scheduled in batch.');
  } else if (framework === 'SysOperationService' || framework === 'SysOperationDataContract') {
    batchCapable = 'unknown';
    add('info', `This is a SysOperation ${framework === 'SysOperationService' ? 'service' : 'data contract'}; batch behaviour is decided by its controller. Run analyze_batch_class on the controller.`);
  } else {
    add('info', 'No batch framework base class (RunBaseBatch, SysOperationServiceController, SysOperationServiceBase) found in the indexed hierarchy.');
  }

  // Retryability
  let retryable: boolean | 'unknown' = 'unknown';
  const isBatchLike = framework === 'RunBaseBatch' || framework === 'SysOperationController';
  if (implementsLower.has('batchretryable') || own.has('isretryable') || inheritedMethods.has('isretryable')) {
    const literal = returnsLiteral(body('isRetryable'));
    retryable = literal ?? 'unknown';
    if (retryable === true) {
      add('info', 'Retryable: the batch framework may re-run this task after a transient failure. The work must be idempotent (safe to execute twice).');
    }
  } else if (isBatchLike) {
    retryable = false;
    add('warning', 'Does not implement BatchRetryable: transient failures (for example SQL deadlocks or connection drops) fail the task instead of retrying it. Implement BatchRetryable.isRetryable() once the work is idempotent.');
  }

  // Pack/unpack for RunBase-style classes
  if (framework === 'RunBaseBatch' || framework === 'RunBase') {
    const hasPack = own.has('pack') || inheritedMethods.has('pack');
    const hasUnpack = own.has('unpack') || inheritedMethods.has('unpack');
    if (hasPack !== hasUnpack) {
      add('error', 'Only one of pack()/unpack() is implemented: both are required to persist dialog values for batch and usage data.');
    } else if (!hasPack) {
      add('warning', 'pack()/unpack() are not overridden: dialog values are not persisted for batch or usage data. Implement both with a CurrentVersion/CurrentList macro.');
    } else if (sources && own.has('pack') && !/\bCurrentVersion\b/.test(stripXppComments(sources.all))) {
      add('warning', 'pack()/unpack() found but no CurrentVersion macro: version the packed container so stored usage data can be upgraded safely.');
    }
    if (!own.has('description')) add('info', 'No static description() override: batch job lists will show a generic caption.');
  }

  // SysOperation controller notes
  if (framework === 'SysOperationController') {
    if (own.has('canruninnewsession') && returnsLiteral(body('canRunInNewSession')) === false) {
      add('info', 'canRunInNewSession() returns false: synchronous runs share the client session (default is a new session).');
    }
  }

  // Idempotency and set-based hints over the run/process body
  const runBody = stripXppComments(body('run') ?? body('process') ?? (sources && sources.methods.size === 0 ? sources.all : ''));
  if (runBody) {
    const inserts = /\.(insert|doInsert)\s*\(|\binsert_recordset\b/i.test(runBody);
    if (retryable === true && inserts && !/\b(exists|find|select\s+firstonly)\b/i.test(runBody)) {
      add('warning', 'Retryable task inserts records without an obvious existence check: a retry could create duplicates.');
    }
    if (/\bwhile\s+select\b[\s\S]{0,400}?\.(update|insert|delete)\s*\(/i.test(runBody)) {
      add('info', 'Row-by-row while select with update/insert/delete in the run body: consider update_recordset/insert_recordset/delete_from, or batch bundles/tasks for large volumes.');
    }
    if (/\bttsbegin\b/i.test(runBody) && !/\bttscommit\b/i.test(runBody)) {
      add('warning', 'ttsbegin without ttscommit in the run body.');
    }
  }

  const failures = buildKqlQuery({ scenario: 'batch-failures', className: obj.name }).query;
  const longRunning = buildKqlQuery({ scenario: 'batch-long-running-tasks', className: obj.name }).query;

  return {
    className: obj.name,
    package: obj.package,
    framework,
    inheritanceChain: chain,
    chainLeavesIndex,
    implements: implementsList,
    batchCapable,
    retryable,
    overrides,
    sourceAvailable: !!sources,
    findings,
    telemetry: { failures, longRunning, attribution: TELEMETRY_ATTRIBUTION },
  };
}

export function registerTelemetryTools(server: McpServer, db: Database) {
  server.tool(
    'generate_kql_query',
    'Generate a ready-to-run KQL query for D365 F&O telemetry (Application Insights customEvents/exceptions) or Commerce store monitoring (Log Analytics). ' +
      'Scenarios cover batch failures, long-running tasks, throttling, thread availability, queue sizes, priorities, X++ exceptions, slow SQL and store health. ' +
      'The query is returned for the user to run; nothing is executed. Based on Microsoft FastTrack FSCM Telemetry Samples (MIT).',
    {
      scenario: z.enum(KQL_SCENARIO_NAMES).describe('Query scenario.'),
      timespan: z.string().optional().describe('Look-back window such as 7d, 12h or 30m (default 7d). Ignored when startTime is given.'),
      startTime: z.string().optional().describe('ISO 8601 start time.'),
      endTime: z.string().optional().describe('ISO 8601 end time (default now).'),
      environmentId: z.string().optional().describe('LCS/PPAC environment id to filter on.'),
      batchJobIds: z.array(z.string()).max(50).optional().describe('Batch job RecIds.'),
      className: z.string().optional().describe('Batch/X++ class name; checked against the index.'),
      computer: z.string().optional().describe('Store machine name (Commerce scenarios).'),
    },
    async (args) => generateKqlQuery(db, args)
  );

  server.tool(
    'analyze_batch_class',
    'Analyze an indexed batch class: framework (RunBaseBatch / SysOperation controller, service or contract), inheritance, batch capability, ' +
      'BatchRetryable status, pack/unpack versioning, idempotency and set-based hints, plus ready KQL queries for its batch telemetry.',
    { className: z.string().min(1) },
    async ({ className }) => {
      const analysis = await analyzeBatchClass(db, className);
      if (!analysis) return fail(`Class ${className} not found in the index.`);
      return ok(JSON.stringify(analysis, null, 2));
    }
  );
}
