# Security (Privileges, Duties, Roles)

> Naming conventions and the two BP checks that catch an incomplete security setup.

- Privilege naming convention: `<Object>Maintain` (CRUD) / `<Object>View` (read). Grant on the entity
  + any menu-item/form entry points.
- **Every duty must be referenced by at least one role** — else `BPErrorDutyNotCoveredByRole`.
  Create an aggregating role.
- Entry-point grants must not be left `Unset` (`BPErrorPreventRedundantEntryPointUnsetGrant`).
