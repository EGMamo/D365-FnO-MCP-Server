---
appliesTo:
  tools: [analyze_batch_class, get_class_hierarchy, search_symbols]
match:
  names: ['*Controller', '*Contract', '*Service']
note: "SysOperation = DataContract + Service + Controller. The controller's new() must be protected (BPErrorClassNewNotProtected) and getFirstQuery() returns the contract query."
---
# SysOperation Batch Pattern

> The standard Contract + Service + Controller shape for a batch-runnable operation.

Contract + Service + Controller:
- **Contract** `[DataContractAttribute]` with `parm*` `[DataMemberAttribute]` accessors; expose an
  AOT query by storing a packed container (`SysQuery::packSimple(new Query(queryStr(Q)))`) and a
  `parmQuery()` decorated `[AifQueryTypeAttribute(identifierStr(Q))]` so the batch dialog shows a
  **Select** button.
- **Service** with the processing method (the SysOperation entry point).
- **Controller** `extends SysOperationServiceController`; `protected new()` sets `parmClassName`/
  `parmMethodName`; static `main()`; override `getFirstQuery()` to return the contract's query.
- Constructor of the controller must be `protected` (`BPErrorClassNewNotProtected`).
