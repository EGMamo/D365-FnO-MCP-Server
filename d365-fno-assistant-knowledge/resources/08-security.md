# Security (Privileges, Duties, Roles)

> Design-time naming, entry-point coverage, and checks for usable custom security.

## Naming and composition

- Name privileges after the object and access intent, for example
  `<Prefix><Object>View` and `<Prefix><Object>Maintain`. Give a distinct action its own
  appropriately named privilege when it should be authorized separately.
- Name duties after business responsibilities, such as `<Prefix><Object>Inquire` or
  `<Prefix><Object>Maintain`; name roles after the job or persona that receives them.
- Give roles, duties and privileges meaningful labels and descriptions using label IDs,
  not literal text. Assign users roles; roles collect duties (and can contain privileges
  directly), while duties collect privileges.

## Grant the intended entry points

- Check every way the user reaches a feature: display, action and output menu items,
  service operations, and separately exposed data entities. Access through a form's
  menu item does not by itself grant an integration access to a data entity.
- Set the intended access level on each grant: for example, `Read` for a view
  privilege, an appropriate write level for maintenance, or `Invoke` for an action
  or service operation. Do not leave entry-point grants at `Unset`:
  `BPErrorPreventRedundantEntryPointUnsetGrant` flags them.
- **Every duty must be referenced by at least one role**, including a role extension,
  or `BPErrorDutyNotCoveredByRole` is reported. Check that privileges are reachable
  through the intended duties and roles as well.
- To add custom duties or privileges to standard security, prefer role/duty extensions
  over copying standard objects. Security changes made only in the Security
  configuration UI are environment data, not AOT metadata in your package.

## Verify access

- Synchronize the database after deploying security metadata. Test with a non-admin
  user holding only the intended role, rather than relying on System administrator
  access. Inspect the form's Security diagnostics to identify the effective
  role/duty/privilege path.
- The index-backed `find_security_path` and `get_security_object` tools can inspect
  *AOT* grants and extensions; they cannot report runtime user assignments or
  unexported Security configuration changes. See `20-security-model.md` for
  traversal, sub-roles, and segregation-of-duties analysis, and
  `11-best-practice-warnings.md` for the BP quick reference.
