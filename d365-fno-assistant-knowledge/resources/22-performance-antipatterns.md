---
appliesTo:
  tools: [list_trace_sessions, find_n_plus_one, find_slow_sql, get_top_methods, search_trace]
match:
  tools: [find_n_plus_one, find_slow_sql, get_top_methods]
note: "Capture one slow scenario in Trace Parser first. Fix N+1 with joins or set-based operations, check indexes for slow SQL, and set CacheLookup to fit the table group."
---
# X++ Performance Anti-Patterns and Trace Analysis

> How to find the usual X++ performance problems in Trace Parser data and fix them in code.

- **Capture first, guess never.** Record a Trace Parser trace (`.etl`) of one slow scenario, on
  a warm system, with the smallest dataset that still reproduces it. Import it into Trace
  Parser, which writes an `AxTrace` SQL database. Then run `index-trace` to load aggregates into
  the index. Durations in `AxTrace` are nanoseconds; the tools report milliseconds.
- **Workflow with the tools.** `list_trace_sessions` → pick the session. `get_top_methods`
  (`orderBy: exclusive`) shows where X++ itself spends time; `orderBy: db` shows where SQL time
  comes from. `find_n_plus_one` and `find_slow_sql` apply the thresholds below. `search_trace`
  finds a method, table or SQL fragment. Each finding links back to the AOT object, so follow up
  with `get_method_signature`, `get_element_xml` or `get_table_schema` on the reported object.
- **N+1 (row-by-row) queries.** Signature: one method line issues many cheap statements
  (the default threshold is more than 100 calls averaging under 5 ms each). Typical causes are a
  `select` or `find()` inside a `while select`, or `update()`/`insert()` per record. Fixes: join
  the lookup into the outer `select` (`join`, `exists join`, `notexists join`), select only the
  fields you need (`select FieldA, FieldB from ...`), load a lookup map once before the loop, or
  use cached finds.
- **Set-based operations.** Replace per-record writes with `insert_recordset`,
  `update_recordset` and `delete_from`, or `RecordInsertList` for computed inserts. They fall
  back to row-by-row if the table overrides `insert`/`update`/`delete`, has database logging,
  alerts or certain delete actions. Call `skipDataMethods(true)`, `skipDatabaseLog(true)` and
  similar only when skipping that logic is correct for the business case.
- **Slow single statements.** Signature: one statement over 5 s, or a large total across
  executions. Check that the `where` clause matches a table index's leading fields
  (`get_table_schema` lists indexes and their fields). Avoid functions on indexed columns and
  leading-wildcard `like`. Watch for missing `DataAreaId`/`Partition` in hand-written
  `Query` ranges, which forces cross-company scans. A missing index is added through a table
  extension; confirm the plan with Query Store in LCS/PPAC before and after.
- **Caching.** `TableGroup` hints at the right `CacheLookup`: `Parameter` tables →
  `EntireTable` (small, rarely changed); `Group`/`Reference` tables → `Found` or
  `FoundAndEmpty`; `Main` → `Found`; `Transaction`/`Worksheet*` → usually `None`. Use
  `SysGlobalObjectCache` or `SysGlobalCache` for computed values; invalidate them explicitly.
  Unique-index `find()` methods only hit the record cache when the `where` clause matches the
  cache key exactly.
- **Other signs.** Many `ttsBegin`/`ttsCommit` levels inside loops (long locks, blocking),
  display methods on grids (run per visible row), and `RunBase`/`SysOperation` jobs that loop
  over all records instead of splitting into batch tasks.
- **Limits of trace data.** Traces show one user's scenario on one environment, and tracing adds
  overhead. `inclusive` time double-counts recursive calls. Method names are mapped to the AOT by
  name, so an unmatched method (kernel, framework or since-renamed code) is still reported with
  `methodIndexed: false`. Imported traces contain user names and SQL text: they are stored only in
  the local index and are removed from published or uploaded indexes.

Thresholds are adapted from the Trace Parser Agent views in Microsoft's Dynamics 365 FastTrack
Implementation Assets (MIT License, Copyright (c) Microsoft Corporation).
