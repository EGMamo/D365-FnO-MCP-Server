---
appliesTo:
  tools: [get_data_entity_details, check_entity_odata_readiness]
note: "Outbound shape: DMF export to an incremental landing folder, a storage-event pipeline that upserts by key, then a callback that writes the sync status back."
---
# Outbound Batch-Integration Architecture Pattern

> A reference architecture for "export from F&O, push to an external system, write status back" —
> useful even with every concrete resource name stripped.

```text
Scheduled trigger
  -> Platform batch/export job (e.g. DMF) produces one or more output files
  -> Files land in cloud storage, in an "incremental" landing folder
  -> A storage-event trigger (scoped ONLY to the incremental prefix, never archive/error)
     starts a data-pipeline run for that one file
  -> Pipeline calls the external system: GET-by-key first, then POST (create) on not-found
     or PUT (update) on found — a generic "upsert via existence check" shape
  -> Pipeline (or a shared callback) writes the result back into the source system:
       - a current-status "sync log" table, keyed by (source table, source key, source line
         number) so one row model covers header-only and header+line sources uniformly
       - optionally, acknowledgement fields directly on the source document
  -> Successful files move to an archive folder; failed files move to an error folder;
     both folders are deliberately outside the trigger's watched prefix so archiving/erroring
     never re-fires the trigger
```

Other reusable details:
- Sync log is a *current-status* table (upsert on the natural key), not an append-only audit log —
  a deliberate, named trade-off (no attempt history) rather than an oversight.
- Splitting a bulky standard entity vs. building a small trimmed one: don't clone a full standard
  data entity if only a handful of fields are needed — a full copy drags in every standard
  relation/field and each throws its own BP warning. Build a narrow entity scoped to exactly what
  the integration needs.
- Multi-file exports where one file's presence gates processing of another (e.g. a "details" file
  uploaded first, a "trigger" file uploaded last) are a deliberate ordering technique to control
  when the downstream trigger fires, not an incidental detail.
