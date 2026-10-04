---
appliesTo:
  tools: [get_table_schema, get_data_entity_details, search_symbols]
match:
  names: ['RetailColorGroup*', 'EcoResColor*']
note: "OData entity field names often differ from the underlying table fields. Check the AxTable XML before using a name in fieldNum() or a relation."
---
# Verified Standard-Schema Facts

> Core F&O schema facts worth knowing outright, because the OData entity names differ from the
> underlying table/field names and this trips people up repeatedly.

**Color groups (product dimension helper):**
- Header table `RetailColorGroupTable`: key `colorGroup` (EDT `RetailColorGroupId`) + `Description`.
  The OData `ProductColorGroup` entity renames `colorGroup` → `GroupId`. There is **no**
  `EcoResProductColorGroup` table.
- Membership `RetailColorGroupTrans`: `color` (EDT `RetailColorId`, relates to `EcoResColor.Name`) +
  `colorGroup` (relates to `RetailColorGroupTable.colorGroup`); natural key `(colorGroup, color)`.
- `EcoResColor` has **no `ColorId` field** — the identifier is `Name` (EDT `EcoResColorName`).
- Filter colors by group: join `EcoResColor.Name == RetailColorGroupTrans.color` + range on
  `RetailColorGroupTrans.colorGroup`.

**Product color (simple dimension):**
- OData `ProductColor` entity exposes `ColorId` (which is the human-readable value itself). A "product
  dimension" natively makes an item a product-master **variant**, so `ProductColorId` lives on the
  *variant* entity (`ReleasedProductVariantsV2`), not the base released product.

**Product category hierarchy (all int64 FKs):**
- `EcoResCategoryHierarchy.Name` (the hierarchy, e.g. "Retail Product Category").
- `EcoResProductCategory` is the assignment/join table: `.Product`, `.Category`, `.CategoryHierarchy`.
- `EcoResCategory`: `.RecId`, `.Name`, `.ParentCategory`, `.CategoryHierarchy`.
- Build a root→leaf path by filtering `EcoResProductCategory` on `(Product, CategoryHierarchy)` then
  walking `EcoResCategory.ParentCategory` up to the root.
