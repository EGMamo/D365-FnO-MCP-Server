---
appliesTo:
  tools: [search_symbols, get_table_schema, get_class_hierarchy, get_method_signature, find_usages, find_references, create_sys_operation]
match:
  names: ['WMSJournal*', 'PurchFormLetter*', 'VendPackingSlip*', 'PurchParm*']
note: "Post the arrival journal first (it registers the quantity), then post the product receipt per purchase order with PurchFormLetter for DocumentStatus::PackingSlip. Receiving 'registered' quantity takes every registration on the PO line, not just this journal's, so limit the parm lines to the journal when that matters."
---
# Arrival Journals to Product Receipts (Batch Posting)

> Posting item arrival journals and then product receipts for the purchase order lines they
> registered, with the journal's packing slip as the receipt number.

> **Verify before relying on it:** class, method, enum and field names below are from standard
> application knowledge, not checked against an index. Confirm each with `get_class_hierarchy`,
> `get_method_signature` and `get_table_schema` on your version before generating code.

## When to use this

A batch job must post open arrival journals and create product receipts for the purchase order
lines in them, using the journal's packing slip id as the product receipt number and the registered
quantity as the received quantity.

## Pattern

1. **Select the journals.** Arrival journals are `WMSJournalTable` headers with `WMSJournalTrans`
   lines; a line links to its purchase order line through `InventTransId` (and the PO through the
   line's reference fields). Filter to unposted journals of the arrival type with a query the batch
   contract exposes, so users can narrow by journal, warehouse or vendor.
2. **Post the arrival journal** through the journal's own check-post class for receptions (the
   `WMSJournalCheckPost*` family) rather than writing inventory transactions yourself. Posting is
   what moves the receipt to *Registered*, which is the quantity the product receipt then picks up.
3. **Group by purchase order.** A product receipt belongs to one purchase order (or a summary
   update). Collect the PO lines the journal touched and post one receipt per PO.
4. **Post the product receipt** with `PurchFormLetter::construct(DocumentStatus::PackingSlip)`:
   - Simple path: `update(purchTable, packingSlipId, transDate, PurchUpdate::Recorded)`, where
     `PurchUpdate::Recorded` means "registered quantity".
   - Precise path: create the parm update, choose lines, then remove the `PurchParmLine` rows for
     lines that are not in the journal and set their receive-now quantity to the journal line
     quantity, and post from the parm table. Use this when other journals may have registered
     quantity on the same PO lines.
   - Set the receipt number (`PurchParmTable.Num` / the `Num` argument) from the journal's packing
     slip id.
5. **Batch shape.** SysOperation contract, controller and service (see the SysOperation topic).
   Process one journal per transaction inside `try`/`catch`, log the failure and continue with the
   next journal; for volume, split into one batch task per journal or per PO.

## Gotchas / notes

- **Registered is per PO line, not per journal.** `PurchUpdate::Recorded` receives everything
  registered on the line from any journal or the mobile app. Use the precise path to receive only
  this journal's quantity.
- **Packing slip ids must be unique per vendor** when the purchase parameters check for used
  packing slips; a rerun with the same id fails. Before posting, look for an existing
  `VendPackingSlipJour` for that PO and packing slip id and skip it, so a retried batch is
  idempotent.
- **Journal without a packing slip id**: decide up front whether to skip the journal or fail it;
  do not let the posting fall back to a number sequence silently.
- **Partial and over-receipts**: the receive-now quantity cannot exceed the remaining deliver
  quantity plus the over-delivery tolerance on the line.
- **Post arrival first, receipt second, in separate transactions.** A failed product receipt must
  not roll back an arrival that was already posted and is physically in the warehouse.
- **Financial dimensions, dates and the posting user** come from the parm table defaults; set the
  transaction date explicitly in a batch, which may run after midnight.

## Related

- d365kb://09-sysoperation-batch-pattern
- d365kb://23-batch-and-telemetry
- d365kb://10-transactions
