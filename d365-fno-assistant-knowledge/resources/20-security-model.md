# Security Model Traversal & Segregation of Duties

> How Role → Duty → Privilege → Entry point resolves, and what the security tools report.

- **The chain.** A role (`AxSecurityRole`) holds duties, privileges directly, and sub-roles.
  A duty (`AxSecurityDuty`) holds privileges. A privilege (`AxSecurityPrivilege`) grants
  *entry points* (menu items, service operations) and *data entity permissions*. A menu
  item points to its target object (`Form`, `Class`, `SSRSReport`) through `ObjectType`/`Object`.
- **Extensions merge into the base.** `AxSecurityRoleExtension` / `AxSecurityDutyExtension`
  named `Base.Suffix` add duties/privileges/sub-roles to `Base`. Always evaluate a role with
  its extensions applied. The index links them with `extends` cross-references.
- **Sub-roles inherit everything.** A role's effective privileges include every sub-role's
  duties and privileges, recursively. Cycles are possible in customized metadata. The tools
  track visited roles and stop at a cycle.
- **Grant levels.** An entry point or entity grant holds levels such as `Read`, `Update`,
  `Create`, `Delete`, `Correct` and `Invoke`. Only levels set to `Allow` count. `Unset` means
  "no grant" (and triggers `BPErrorPreventRedundantEntryPointUnsetGrant`).
- **"Who can open form X?"** Resolve backwards: form ← menu items targeting it ← privileges
  granting those menu items ← duties/roles holding them ← parent roles (via sub-role).
  `find_security_path` does this and marks inherited paths with `viaSubRole`.
- **Segregation of duties (SoD).** A conflict is a *pair of duties* that one person should
  not hold together (for example "maintain vendor master" + "approve vendor payments").
  Evaluate rules against the *effective* duty set (extensions + sub-roles). A role can
  violate a rule only through a nested sub-role. `analyze_sod_conflicts` takes rules as
  `{name, dutyA, dutyB}` pairs. The rule set is yours to define. Nothing is built in.
- **Limits of static analysis.** The index sees AOT metadata, not runtime assignments. It
  cannot tell *which users* hold a role, apply XDS/record-level policies, or see
  security configuration made in the UI (Security configuration workspace) that was never
  exported to code. Use it for design-time review, not as an audit of production access.
- **Tools.** `get_security_object` (role/duty/privilege, optionally flattened),
  `find_security_path`, `analyze_sod_conflicts` and `diff_roles`.
