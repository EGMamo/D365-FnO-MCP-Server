# Exposing F&O Data and Actions to AI Agents

> How integrations, Power Platform and Copilot Studio agents reach F&O data. What the entity tools check and generate.

- **Four routes.** (1) OData on public data entities (`/data/<PublicCollectionName>`), used by
  the Fin & Ops Apps connector and by custom HTTP calls. (2) Dataverse *virtual tables*
  (`mserp_*`), which surface the same public entities inside Dataverse and Copilot Studio.
  (3) Microsoft's official Dynamics 365 ERP MCP server. Agents use it to read data and run
  form actions, and it is allowed per client in *Allowed MCP Clients*. (4) Custom services
  (SysOperation/JSON services). All four run as the calling user, so F&O security still decides
  what the agent can see.
- **What makes an entity OData-ready.** `IsPublic = Yes`, a non-empty and unique
  `PublicEntityName` and `PublicCollectionName`, and a `PrimaryKey` naming a key under
  `Keys`. The key must be backed by a unique table index. A duplicate key breaks
  `GET /data/Set(key)`. Container/blob fields are not served. Computed/unmapped fields are
  read-only. `check_entity_odata_readiness` reports blockers, warnings, the entity set URL and
  which privileges/roles grant the entity.
- **Virtual table eligibility follows OData.** A virtual table needs the same public names and
  a key. The entity must also be refreshed in the Dataverse *Finance and Operations Virtual
  Tables* list before it appears there. Company-specific entities surface a `company` column.
- **Keys.** Build the entity key from the table's natural key: `ReplacementKey`, then an
  `AlternateKey` index, then the first unique index. Never use `RecId` for integration keys.
  `create_data_entity` picks the key this way and adds missing key fields. For company tables
  it adds `dataAreaId` and `PrimaryCompanyContext`.
- **Read-only by default for agents.** Give an agent the smallest surface: a read-only entity
  (`IsReadOnly = Yes`) and a dedicated role that holds only `Read` on the entities it needs.
  `create_readonly_role_for_entities` emits the privilege (`<Role>View`), the duty
  (`<Role>Inquire`) and the role. Assign it to the agent's service user or app registration.
  FastTrack's Compliance Advisor agent uses this pattern (`AuditAgentReader`).
- **Write access is a separate decision.** Use `create_security_privilege` with
  `access: maintain` (Read/Update/Create/Delete) only for entities the agent must change. Menu
  item grants follow the same presets. Action menu items get `Invoke`. Data entities never get
  `Invoke`.
- **Actions instead of raw writes.** For business operations (post, approve, recalculate),
  expose an OData action rather than letting the agent patch fields. A
  `[SysODataActionAttribute('name', isInstance)]` method on the entity or an extension of it
  is called with `POST /data/Set/Microsoft.Dynamics.DataEntities.name` (static) or
  `POST /data/Set(key)/Microsoft.Dynamics.DataEntities.name` (instance).
  `create_odata_action` generates the extension with grounded parameter types. Keep actions
  idempotent and validate inputs. The agent will retry.
- **Data management is separate.** The generated entity sets `DataManagementEnabled = No`.
  DMF import/export needs a staging table. Generate it with the Visual Studio data entity
  wizard, or enable data management there, rather than hand-writing the staging table.
- **Limits.** The tools read metadata only. Configuration can still block access: OData
  service availability, virtual table refresh, Allowed MCP Clients, license and role
  assignment. Verify these in the target environment. A hosted index without raw XML cannot
  inspect keys, so readiness degrades to warnings and `create_data_entity` fails closed.
