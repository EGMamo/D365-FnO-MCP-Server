---
appliesTo:
  tools: [search_symbols, get_table_schema, get_class_hierarchy, get_method_signature, get_data_entity_details, find_usages, find_references, create_sys_operation, create_runbase_batch]
match:
  names: ['SalesOrderHeader*Entity', 'SalesOrderLine*Entity', 'SalesTableType*', 'SalesLineType*', 'ExcelPackage', 'FileUpload*']
note: "Check whether a Data management import project on the standard sales order header and line entities already covers the Excel file before writing code. In custom X++, create orders through SalesTable and SalesLine init methods and SalesLine.createLine, one order per transaction, and keep the uploaded file in storage the batch can read."
---
# Sales Orders from an Excel File

> Creating sales orders automatically from an uploaded Excel workbook: the standard import path
> first, and the custom X++ pattern when the file layout or rules need code.

> **Verify before relying on it:** entity, class, method and field names below are from standard
> application knowledge, not checked against an index. Confirm each with `get_data_entity_details`,
> `get_class_hierarchy`, `get_method_signature` and `get_table_schema` on your version before
> generating code.

## When to use this

Users drop an Excel file of orders (customer, item, quantity, price, dates) and the system must
create the sales orders and lines without manual entry, either on demand or on a batch schedule.

## Pattern

1. **Try the standard import first.** A Data management import project with an Excel source on the
   standard sales order header and line entities (the `SalesOrderHeader*Entity` and
   `SalesOrderLine*Entity` family; check which versions your release ships) needs no code. It
   handles staging, validation errors per row and recurring imports. Choose code only when the
   file layout cannot be mapped (one row per line with header data repeated, lookups by external
   codes, defaulting rules) or users need a one-click upload on a form.
2. **Get the file to where the batch runs.** A batch task has no client, so upload the file
   interactively (the `FileUpload` control or `File::GetFileFromUser`, which stores it in temporary
   blob storage) and either parse it right away or persist it (a staging table, document
   attachment or an Azure storage container) for the batch to read. Temporary upload links expire.
3. **Read the workbook** with the `OfficeOpenXml` (EPPlus) library that ships with the platform:
   `ExcelPackage` over the file stream, the first `ExcelWorksheet`, then loop over the used rows
   reading cells by column. Validate the header row names instead of trusting column positions.
4. **Stage, then create.** Write each row to a custom staging table with a status and error text,
   so bad rows are visible and can be fixed and retried. Group the rows into orders (by customer
   plus the external order reference).
5. **Create each order** in its own `ttsbegin`/`ttscommit` inside `try`/`catch`:
   - Header: `salesTable.clear()`, set `CustAccount`, call `initValue()` and `initFromCustTable()`,
     take `SalesId` from the number sequence (`NumberSeq` on the sales id reference), set dates and
     the external reference, `insert()`.
   - Lines: `salesLine.clear()`, `initFromSalesTable(salesTable)`, set `ItemId`, inventory
     dimensions, `SalesQty`, then `salesLine.createLine(...)` with the flags that run validation,
     item defaults, quantity calculation and price search. Set a price from the file only after
     `createLine`, or the price search overwrites it.
   - The `SalesTableType` and `SalesLineType` classes are what `insert` and `createLine` call, so
     extend those with Chain of Command when defaults must change for every order, not only imports.
6. **Batch shape.** SysOperation contract, controller and service; one order per transaction, so a
   bad row fails its own order and the rest continue. Log per row and mark the staging status.

## Gotchas / notes

- **Idempotency.** A rerun must not create the same orders twice. Store the file's order reference
  on the order (for example the customer reference or a custom field) and skip references that
  already exist for that customer.
- **Company.** The batch runs in the company it was scheduled in; switch with `changecompany` when
  the file carries a legal entity column.
- **Item and customer lookups by external codes** (customer item numbers, EAN barcodes) belong in
  the staging validation, with a clear error per row, not in the creation step.
- **Excel cell types.** Dates arrive as numbers or text depending on the cell format, and quantities
  can carry locale decimal separators. Parse explicitly and reject what does not parse.
- **Credit limits, holds and required fields** raise errors or warnings inside `createLine` and
  `insert`; capture the infolog text into the staging row instead of losing it.
- **Large files**: commit per order and keep the workbook out of memory between batch tasks; split
  into batch tasks by order group for volume.

## Related

- d365kb://03-data-entities
- d365kb://09-sysoperation-batch-pattern
- d365kb://10-transactions
- d365kb://23-batch-and-telemetry
