# Form Patterns & UI Layout

> How the web client builds forms, which pattern to pick, and the layout properties that actually
> control responsive behaviour. Grounded in the Microsoft user interface development guidance.

## Pattern

Every form in the web client is split into a **logical half** and a **physical half**. The X++ form,
data source, and control API plus their state live on the server; the rendered presentation is HTML,
JavaScript, and CSS in the browser. The two halves stay in sync through service calls, and the server
holds form state in memory for as long as the form is open. The form metamodel is unchanged, so
almost all form, data source, and control metadata and override methods still apply — but control
types that depend on a desktop host (ActiveX, managed-host style controls) are gone, and custom
visuals must go through the extensible control framework instead.

On top of the metamodel sits the **form pattern** system. A pattern is a declarative contract applied
to `Form.Design` that fixes the required and optional control structure and locks a set of layout
properties. A **subpattern** does the same for an individual container control (a FastTab, a group,
a panorama section). Applying a pattern does three things at once:

1. Validates structure — missing or misplaced controls become build errors in the error list.
2. Sets and then hides the properties the pattern owns, so they cannot drift.
3. Guarantees responsive layout and a predictable look that matches the rest of the product.

Pick the pattern from metadata first, visuals second:

- Read `Form.Design.Style`. It usually names the intended pattern directly: `DetailsFormMaster`,
  `DetailsFormTransaction`, `ListPage`, `SimpleList`, `SimpleListDetails`, `TableOfContents`,
  `Dialog`, `DropDialog`, `Lookup`, `FormPart`.
- Where `Style` is `Auto`, infer from shape: a single data source with Overview/General tabs is Task
  Single; two sets of header plus lines is Task Double; a single record focus is Simple Details; a
  single tab control with Next/Previous is Wizard; a bare grid with buttons is Simple List.
- Treat `Style` as a hint, not truth. Common mismatches: a master that is really a transaction form
  because it has lines; a Simple List that is really Simple List & Details because it has more than a
  grid and filter fields; a Simple List that is really a List Page because it carries FactBox parts
  or has a matching details form.
- Confirm against the form's intent and visuals before committing. Apply with **Apply pattern** on
  the `Design` node, then resolve the reported errors by moving existing controls into the positions
  the pattern expects, or creating the ones that are missing.

Top-level patterns cover Details Master, Details Transaction, Simple Details, Simple List, Simple
List & Details, List Page, Table of Contents, Wizard, Workspace, and the Task variants. Support
patterns cover Dialog, Drop Dialog, Lookup, Advanced Selection, and FactBox. Subpatterns cover
container-level content such as fields and field groups, tabular fields, toolbar and list, toolbar
and fields, filters and toolbar, list panel, nested simple list and details, and the panorama section
variants (chart, tiles, tabbed list, related links).

Layout inside any container is driven by four property groups, not by manual pixel sizing:

- `ArrangeMethod` — `Vertical` (default for groups and non-panorama tab pages), `HorizontalLeft`,
  `HorizontalRight`, or `HorizontalWrap` (default for panorama tab pages, wraps at a fixed column
  width for tiles).
- `ColumnsMode` with `Columns` — `Fixed` distributes controls evenly across a stated column count and
  gives leftmost columns the remainder; `Fill` generates as many columns as the available space
  allows, flowing horizontally for groups and tabs and vertically for panorama tabs.
- `HeightMode`/`Height` and `WidthMode`/`Width` — `SizeToAvailable` fills the parent axis (default for
  grids and all tab styles), `SizeToContent` shrinks to the children (default for groups and for
  FastTabs that are not always expanded), `Manual` pins a pixel value.
- Container controls are `Form.Design`, `Group`, `Tab`, `TabPage`, and `ButtonGroup`. A grid borrows
  some container behaviour such as flexible sizing but is not a general-purpose container.

## When to use this

- Creating a new form and deciding which pattern to apply before writing any control metadata.
- Reviewing or extending a form that shows `Pattern: <unselected>` on its design node, or container
  controls still marked unspecified.
- Diagnosing why a form fails to build with pattern structure errors after a metadata edit.
- Explaining why a property is missing from the property pane, or why a form does not resize the way
  a developer expected.
- Migrating or modernising a legacy form whose structure predates the pattern system.

## Gotchas

- **Pattern-owned properties are hidden, not absent.** If a property you expect is missing from the
  property pane, the pattern owns it. Do not fight it; if you genuinely need control, remove the
  pattern deliberately and accept that you also lose the structural validation.
- **Removing a pattern does not revert its property writes.** Applying a pattern stamps values onto
  the covered controls. Removing it only stops the enforcement — the stamped values stay. Undo, or a
  source control revert, is the only clean way back from a wrong pattern.
- **Structure errors point at the pattern's expectation, not at your intent.** Resolve them by moving
  a control into the position the pattern requires rather than by adding a duplicate control
  elsewhere.
- **Subpatterns are a separate, easily missed step.** Applying a top-level pattern leaves container
  controls unspecified. Search the designer for unspecified containers and apply the right subpattern
  to each; otherwise layout quality and validation are only half applied.
- **Manual heights and widths are discouraged.** They do not adapt to form density changes and are a
  frequent cause of forms that look wrong on different screen sizes or density settings. Prefer
  `SizeToAvailable` or `SizeToContent`.
- **`Columns` is ignored under horizontal arrangement.** With `HorizontalLeft` or `HorizontalRight`
  controls lay out in a strict horizontal line with no wrapping, so the column count has no effect.
- **`Auto` sizing is resolved at runtime** and usually behaves like `SizeToContent`. Do not rely on it
  to mean "fill".
- **Custom visuals need the extensible control framework.** Desktop-era embedded control hosts are not
  available, and forms built around custom patterns need their own test coverage because the standard
  pattern validation does not apply to them.

## Related

- Field group naming and the auto-generated `DataGroup` container trap.
- Lookup forms and filtering behaviour.
- Label files, for the labels that pattern-required controls expect.
- Best practice warnings raised during form builds.
