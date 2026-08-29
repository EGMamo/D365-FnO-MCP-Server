# Chain of Command (`[ExtensionOf]`) — the #1 Gotcha

> The `[ExtensionOf]` selector function depends on the *target type*, not on how the code looks —
> getting this wrong compiles cleanly but silently never attaches.

The selector function in the attribute depends on the **target type**, not on how the code looks:

| Target | Selector | Notes |
|---|---|---|
| Plain X++ class | `classStr(MyClass)` | |
| Table | `tableStr(MyTable)` | |
| View | `tableStr(MyView)` | |
| **Data entity view** | `tableStr(MyEntity)` | Even though it's written like a class! |
| Form | `formStr(MyForm)` | |
| Query | `queryStr(MyQuery)` | |

Using `classStr()` on a table/view/**data entity view** **compiles but silently fails to attach** —
the extension becomes an orphan standalone class and the overridden method (e.g. `postLoad`)
**never fires**. Classic symptom: a computed/virtual OData field is always empty.

- Convention for CoC extension class names: `<Target>_<Model>_Extension`. VS auto-renames to this;
  match it when creating new ones.
- CoC needs the target method to be hookable (not `final`/sealed). Standard MS methods usually are.
