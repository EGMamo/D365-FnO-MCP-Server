---
appliesTo:
  tools: [search_symbols, list_objects, get_table_schema, get_element_xml, get_class_hierarchy]
filter:
  exclude:
    - { field: file_path, pattern: '*XppMetadata*' }
    - { field: file_path, pattern: '*XppSource*' }
note: "Edit only Metadata/<Model>/<Model>/Ax<Type>/<Name>.xml. XppSource and XppMetadata are build-output mirrors, and the VS designer rewrites files, so re-check a file after opening it there."
---
# AOT Metadata Source Layout

> Where real F&O customization source lives vs. build-output mirrors, and how the Visual Studio
> designer silently rewrites files.

- Real AOT source is XML under `Metadata/<Model>/<Model>/Ax<Type>/<Name>.xml`
  (`AxTable`, `AxClass`, `AxForm`, `AxFormExtension`, `AxTableExtension`, `AxDataEntityView`,
  `AxDataEntityViewExtension`, `AxEdt`, `AxEnum`, `AxMenuItemAction`, `AxMenuItemDisplay`,
  `AxSecurityPrivilege`, `AxSecurityDuty`, `AxSecurityRole`, `AxLabelFile`, …). **Edit these.**
- A flattened `XppSource/**` tree (method bodies only, no schema XML) is a **build/reference
  output**. Use it for searching; **never create or edit** files there — changes there don't
  affect the build.
- A lean `.rnrproj` build project does **not** need to list every AOT item; adding a new `Ax*` XML
  file is picked up without editing the project file.
- **The VS designer/formatter rewrites files.** It re-orders properties, strips manually-added
  properties (e.g. `DeveloperDocumentation`), regenerates staging tables, and drops hand-added
  unmapped fields / methods. **Always re-check a file after opening it in the designer.**
