---
appliesTo:
  tools: [analyze_batch_class, generate_kql_query, create_sys_operation, create_runbase_batch]
match:
  tools: [analyze_batch_class]
note: "Use SysOperation for new batch work and make retryable batches idempotent before setting BatchRetryable. Batch telemetry events can be queried with KQL."
---
# Batch Framework Best Practices and Telemetry

> How to write batch classes that are safe to schedule and retry, and how to watch them with
> Application Insights telemetry.

- **Pick the framework.** New work uses SysOperation. A controller (`SysOperationServiceController`)
  handles dialog, batch and execution mode. A service (`SysOperationServiceBase`) does the work.
  A `[DataContractAttribute]` class carries the parameters. Keep `RunBaseBatch` for existing
  code. A class that extends plain `RunBase` cannot be scheduled in batch. Run
  `analyze_batch_class` on the controller or the RunBaseBatch class, since the controller decides
  batch behaviour.
- **Batch capability.** `RunBaseBatch` and SysOperation controllers can go to batch by default.
  Override `canGoBatch()` only to turn batch off. `canRunInNewSession()` on a controller decides
  whether synchronous runs get their own session.
- **Persist parameters (RunBase).** Implement `pack()` and `unpack()` together. Version the
  container with `#define.CurrentVersion(n)` and a `#localmacro.CurrentList`, and handle older
  versions in `unpack()`. Without this, scheduled jobs lose their dialog values. SysOperation data
  contracts serialize themselves.
- **Retries and idempotency.** Implement `BatchRetryable` and return `true` from `isRetryable()`.
  The batch framework then re-runs the task after a transient failure, such as a SQL deadlock,
  lost connection or service restart. Before you return `true`, make the work idempotent: a
  second run after a partial run must not double-post or insert duplicates. Check for existing
  records first, commit in small units that can be recognised as done, and prefer
  `update_recordset` over deltas such as `qty += x`.
- **Throughput.** Split large volumes into batch tasks or bundles, so work spreads across batch
  threads and AOS instances. Avoid one huge transaction. Replace row-by-row `while select` +
  `update()`/`insert()` with `update_recordset`, `insert_recordset`, `delete_from` or
  `RecordInsertList`. Use batch groups and priority-based scheduling for critical jobs instead of
  dedicating servers.
- **Descriptions.** Give every batch class a static `description()` (or a controller caption), so
  batch job lists and telemetry (`BatchJobCaption`) stay readable.
- **Telemetry setup.** In the environment, turn on batch telemetry in *Monitoring and telemetry
  parameters* and connect Application Insights. Batch events need 10.0.44 (build 7.0.7606.126+)
  or 10.0.45 (build 7.0.7690.21+) or later. The events land in `customEvents`:
  - `BatchTaskStart`, `BatchTaskFinished` and `BatchTaskFailure` (task lifecycle, correlated by
    `activityId`).
  - `BatchThrottled` (CPU, memory or SQL DTU pressure; `BatchJobId` is always 0).
  - `BatchThreadInfo` (thread capacity) and `BatchQueuesDetails` (queue depth per priority).

  X++ exceptions go to `exceptions`, with `ExecutionMode == "Batch"` for batch runs. Slow SQL
  shows up as `LongRunningQuery` events. Always read fields through
  `parse_json(customDimensions)`, and `InfoMessage` through a second `parse_json`.
- **Querying.** `generate_kql_query` returns ready-to-run KQL for batch failures, long-running
  tasks, throttling, thread availability, queue sizes, priority mix, batch or X++ exceptions and
  slow SQL, plus Commerce store health from Log Analytics. You can filter by environment id, batch
  job RecIds, class or store machine. The tool only generates text; you run the query in
  Application Insights or Log Analytics.
- **Reading the results.**
  - Failures without an infolog error usually show up in `BatchTaskFailure` with a call stack.
  - Tasks with a high `RetryCount` point to transient failures, so check retry safety.
  - Throttling that lines up with long-running tasks means the environment is saturated, so
    reschedule or split the work.
  - Low available threads with a growing normal or low queue calls for revisiting priorities and
    batch groups.

Query shapes and field names are adapted from Microsoft's Dynamics-365-FastTrack-FSCM-Telemetry-Samples
and the FastTrack Batch Framework Telemetry and Store Monitoring agents (MIT License, Copyright (c)
Microsoft Corporation).
