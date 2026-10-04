---
appliesTo:
  tools: [get_method_signature, find_usages, get_class_hierarchy]
note: "To skip a CoC side effect on one call path, use a static context class with push/pop state scoped to the call, not a global boolean."
---
# Context-Scoped Chain-of-Command Side-Effect Suppression Pattern

> The general answer to "a business-logic side effect on write fires even for writes that
> shouldn't trigger it."

- **Problem shape:** a CoC extension on a transaction line table resets a status field to "Pending"
  on every ordinary update (by design, for the normal user-edit path). An inbound integration
  callback needs to update that *same* status field to something else (e.g. "Sent"/"Failed") via
  the entity/OData path — but going through the normal update path immediately triggers the CoC
  reset, undoing the write the integration just made.
- **Solution:** a small static context class exposing `parmIsActive`-style state, scoped by session
  and call-stack depth (not just a global boolean), with explicit push/pop so nested calls restore
  the *previous* state rather than clobbering it to `false`. The integration's update path wraps its
  write in `<Context>::activate() { ... }`; the CoC override checks the context and skips its
  side effect only while active.
- Applicable to any auto-reset/auto-recalculate CoC hook, not just status fields — this is a named,
  reusable pattern rather than a one-off workaround.
