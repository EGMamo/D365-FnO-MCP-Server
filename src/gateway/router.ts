import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { getObjectHeader } from '../indexer/db.js';
import { CODE_TYPES } from '../tools/codeQuality.js';
import { SECURITY_TYPE_TO_AOT } from '../tools/security.js';
import { logger } from '../utils/logger.js';
import { containsPrivateName, errorResult, sanitizeReason, warningsOf, withWarnings } from './merge.js';
import { objectStrategies } from './strategies/objects.js';
import { searchStrategies } from './strategies/search.js';
import { xrefStrategies } from './strategies/xrefs.js';
import type { LocalTools, MergeFn, RouteContext, UpstreamPort } from './types.js';

/** How the gateway answers a tool call: from the local index only, by whoever owns the named object, by merging both sides, or by the hosted server alone. */
export type RouteKind = 'local' | 'owner' | 'merge' | 'forward';

/** Answered from the local index and never sent upstream. */
export const LOCAL_ONLY_TOOL_NAMES: readonly string[] = ['local_index_status', 'get_visual_studio_workspace'];

/** Hosted and local results are combined by a strategy module. */
export const MERGE_TOOL_NAMES: readonly string[] = [
  'search_symbols',
  'list_objects',
  'list_packages',
  'list_models',
  'search_labels',
  'search_labels_fts',
  'resolve_label',
  'resolve_label_by_language',
  'get_table_schema',
  'get_class_hierarchy',
  'find_field_access',
  'find_references',
  'analyze_impact',
  'find_usages',
];

/** The object a tool names, and the indexed types it may be. */
interface ObjectRef {
  name: string;
  types: readonly string[];
}

/** Finds the object a call is about from its parsed args; null when the call needs no hosted answer (check_xpp_best_practices with inline source). */
type OwnerLookup = (args: Record<string, unknown>) => ObjectRef | null;

/** The types validateCoCTarget resolves a Chain of Command target against, in its order. */
const COC_TARGET_TYPES = ['Class', 'Table', 'Form'];

const byName =
  (nameKey: string, types: readonly string[]): OwnerLookup =>
  (args) => {
    const name = args[nameKey];
    return typeof name === 'string' ? { name, types } : null;
  };

/** The type comes from another arg when given, otherwise any of `fallback`. */
const byNameAndType =
  (nameKey: string, typeKey: string, fallback: readonly string[]): OwnerLookup =>
  (args) => {
    const name = args[nameKey];
    const type = args[typeKey];
    if (typeof name !== 'string') return null;
    return { name, types: typeof type === 'string' ? [type] : fallback };
  };

const securityObject: OwnerLookup = (args) => {
  const { name, type } = args;
  if (typeof name !== 'string' || typeof type !== 'string' || !Object.hasOwn(SECURITY_TYPE_TO_AOT, type)) return null;
  return { name, types: [SECURITY_TYPE_TO_AOT[type as keyof typeof SECURITY_TYPE_TO_AOT]] };
};

/** Tools answered by whoever owns the named object: the local index when it holds it, the hosted server otherwise. */
const OWNER_LOOKUPS: ReadonlyMap<string, OwnerLookup> = new Map<string, OwnerLookup>([
  ['get_enum_values', byName('enumName', ['Enum'])],
  ['get_edt_details', byName('edtName', ['Edt'])],
  ['get_form_datasources', byName('formName', ['Form'])],
  ['get_query_datasources', byName('queryName', ['Query'])],
  ['get_data_entity_details', byName('entityName', ['DataEntity'])],
  ['get_method_signature', byName('className', ['Class'])],
  ['get_method_source', byNameAndType('objectName', 'objectType', CODE_TYPES)],
  ['get_element_xml', byNameAndType('name', 'type', [])],
  ['get_security_object', securityObject],
  // Pasted source is checked locally: custom code must not leave the machine.
  ['check_xpp_best_practices', (args) => (args.source !== undefined ? null : byNameAndType('objectName', 'objectType', CODE_TYPES)(args))],
  ['create_coc_extension', byName('targetClass', COC_TARGET_TYPES)],
  ['create_class_extension', byName('targetClass', COC_TARGET_TYPES)],
  ['create_table_extension', byName('targetTable', ['Table'])],
  ['create_event_handler', byNameAndType('targetName', 'targetType', ['Table', 'Class'])],
  ['create_form_event_handler', byName('formName', ['Form'])],
]);

/** Owner-routed tools; check_xpp_best_practices is also local-only whenever it is given source. */
export const OWNER_ROUTED_TOOL_NAMES: readonly string[] = [...OWNER_LOOKUPS.keys()];

const LOCAL_ONLY = new Set(LOCAL_ONLY_TOOL_NAMES);
const MERGE = new Set(MERGE_TOOL_NAMES);

/** The static route of a tool; every name that is not listed above is forwarded unchanged. */
export function routeFor(name: string): RouteKind {
  if (LOCAL_ONLY.has(name)) return 'local';
  if (OWNER_LOOKUPS.has(name)) return 'owner';
  if (MERGE.has(name)) return 'merge';
  return 'forward';
}

/** What a property's schema lets through besides its name: the enum members (as a set) and the numeric bounds. */
function constraintsOf(property: unknown): string {
  const schema = typeof property === 'object' && property !== null ? (property as Record<string, unknown>) : {};
  const members = Array.isArray(schema.enum) ? schema.enum.map(String).sort() : null;
  return JSON.stringify([members, schema.minimum ?? null, schema.maximum ?? null]);
}

/**
 * Merge tools whose hosted input schema has other properties than the local zod shape, or other enum members
 * or numeric bounds on them. Their hosted and local arguments no longer mean the same thing (the gateway
 * validates with its own schema, so it would reject a value the hosted server added), so the router forwards
 * them instead of merging. A tool the hosted server does not list is not skewed: its hosted leg fails and the
 * call degrades.
 */
export function computeSkewedTools(
  hostedTools: ReadonlyMap<string, Tool>,
  local: LocalTools,
  mergeToolNames: readonly string[]
): Set<string> {
  const skewed = new Set<string>();
  const localSchemas = new Map(local.definitions().map((definition) => [definition.name, definition.inputSchema]));
  for (const name of mergeToolNames) {
    const hosted = hostedTools.get(name);
    const localKeys = local.shapeKeys(name);
    if (!hosted || !localKeys) continue;
    const hostedProperties = hosted.inputSchema?.properties ?? {};
    const hostedKeys = new Set(Object.keys(hostedProperties));
    if (hostedKeys.size !== localKeys.length || localKeys.some((key) => !hostedKeys.has(key))) {
      skewed.add(name);
      continue;
    }
    const localProperties = localSchemas.get(name)?.properties ?? {};
    if (localKeys.some((key) => constraintsOf(localProperties[key]) !== constraintsOf(hostedProperties[key]))) skewed.add(name);
  }
  return skewed;
}

const HOSTED_UNAVAILABLE = 'hosted unavailable';
const HOSTED_SKIPPED = 'hosted lookup skipped';

const PRIVATE_NAME_WARNING = `${HOSTED_SKIPPED}: the arguments contain a name with a private prefix (D365_GATEWAY_PRIVATE_PREFIXES), so nothing was sent to the hosted server; these are local results only`;
const PRIVATE_NAME_ERROR =
  'Not sent to the hosted server: the arguments contain a name with a private prefix (D365_GATEWAY_PRIVATE_PREFIXES), and this tool is answered by the hosted server only.';

const unavailableWarning = (reason: string) => `${HOSTED_UNAVAILABLE}: ${reason}`;
const NOT_CONNECTED = 'the hosted server is not connected';

/** A hosted call the gateway withheld or that failed; carries the warning to show. */
class HostedLegError extends Error {}

/** The reason text for a failure of the hosted server, without the "MCP error -32000:" framing of the SDK. */
function failureReason(error: unknown): string {
  return sanitizeReason(error).replace(/^MCP error -?\d+: /, '');
}

/** The hosted server answered but refused the call (unknown tool, invalid params): it is reachable. */
const isRefusal = (error: unknown): boolean =>
  error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed;

/** Sends a call to the hosted server alone. Privacy and availability are checked before anything is sent. */
async function forwardOnly(name: string, args: Record<string, unknown>, ctx: RouteContext): Promise<CallToolResult> {
  if (containsPrivateName(args, ctx.privatePrefixes)) return errorResult(PRIVATE_NAME_ERROR);
  if (!ctx.upstream.isAvailable()) return errorResult(`hosted server unavailable: ${NOT_CONNECTED}.`);
  try {
    return await ctx.upstream.callTool(name, args);
  } catch (error) {
    return errorResult(
      isRefusal(error)
        ? `hosted server rejected the call: ${failureReason(error)}`
        : `hosted server unavailable: ${failureReason(error)}`
    );
  }
}

/** The tools/call arguments of a request, which may arrive without any. */
const argsOf = (rawArgs: Record<string, unknown> | undefined): Record<string, unknown> =>
  typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? rawArgs : {};

/** The text the SDK builds for invalid tool arguments, so a local rejection reads like a hosted one. */
function describeIssues(name: string, error: ZodError): string {
  const issues = error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.message} at ${issue.path.join('.')}` : issue.message))
    .join('\n');
  return `Input validation error: Invalid arguments for tool ${name}: ${issues}`;
}

/** Parses args with the tool's local zod shape (defaults applied); invalid args become the result to return. */
function parseLocally(
  name: string,
  args: Record<string, unknown>,
  ctx: RouteContext
): { parsed: Record<string, unknown> } | { rejected: CallToolResult } {
  try {
    return { parsed: ctx.local.parseArgs(name, args) };
  } catch (error) {
    if (error instanceof ZodError) return { rejected: errorResult(describeIssues(name, error)) };
    throw error;
  }
}

async function runLocal(name: string, args: Record<string, unknown>, ctx: RouteContext): Promise<CallToolResult> {
  if (!ctx.local.has(name)) return errorResult(`Tool ${name} is not available in the gateway.`);
  const checked = parseLocally(name, args, ctx);
  if ('rejected' in checked) return checked.rejected;
  await ctx.localIndex.ensureFresh();
  return ctx.local.call(name, checked.parsed);
}

/** Whether the local index holds the object (same casing rules as the tools themselves). */
function ownsLocally(ref: ObjectRef, ctx: RouteContext): boolean {
  return ref.types.some((type) => getObjectHeader(ctx.localIndex.db, ref.name, type) !== null);
}

async function runOwner(name: string, args: Record<string, unknown>, ctx: RouteContext): Promise<CallToolResult> {
  const lookup = OWNER_LOOKUPS.get(name);
  if (!lookup || !ctx.local.has(name)) return forwardOnly(name, args, ctx);
  const checked = parseLocally(name, args, ctx);
  if ('rejected' in checked) return checked.rejected;
  await ctx.localIndex.ensureFresh();

  const ref = lookup(checked.parsed);
  if (ref === null || ownsLocally(ref, ctx)) return ctx.local.call(name, checked.parsed);

  // The hosted server owns it, unless the call cannot or must not go there: then the local answer
  // (usually "not found", with local suggestions) is all there is, and the warning says why.
  const withheld = async (warning: string) => withWarnings(await ctx.local.call(name, checked.parsed), [warning]);
  if (containsPrivateName(args, ctx.privatePrefixes)) return withheld(PRIVATE_NAME_WARNING);
  if (!ctx.upstream.isAvailable()) return withheld(unavailableWarning(NOT_CONNECTED));
  try {
    return await ctx.upstream.callTool(name, args);
  } catch (error) {
    return withheld(unavailableWarning(failureReason(error)));
  }
}

/**
 * The hosted server as a merge strategy sees it. Nothing private is ever sent: a call is refused when
 * the original arguments or the ones the strategy passes contain a private name. After the first
 * failure the hosted leg stays down for the rest of the call, so a strategy that makes several
 * hosted calls does not wait for a timeout on each. `warnings` says what, if anything, was lost.
 */
function guardUpstream(
  args: Record<string, unknown>,
  ctx: RouteContext
): { port: UpstreamPort; warnings: () => string[] } {
  const everythingPrivate = containsPrivateName(args, ctx.privatePrefixes);
  let failure = !everythingPrivate && !ctx.upstream.isAvailable() ? unavailableWarning(NOT_CONNECTED) : null;
  let withheldSome = everythingPrivate;

  const port: UpstreamPort = {
    isAvailable: () => !everythingPrivate && failure === null && ctx.upstream.isAvailable(),
    listTools: () => ctx.upstream.listTools(),
    get serverVersion() {
      return ctx.upstream.serverVersion;
    },
    async callTool(name, callArgs) {
      if (everythingPrivate) throw new HostedLegError(PRIVATE_NAME_WARNING);
      if (failure !== null) throw new HostedLegError(failure);
      if (containsPrivateName(callArgs, ctx.privatePrefixes)) {
        withheldSome = true;
        throw new HostedLegError(PRIVATE_NAME_WARNING);
      }
      try {
        return await ctx.upstream.callTool(name, callArgs);
      } catch (error) {
        failure = unavailableWarning(failureReason(error));
        throw error;
      }
    },
  };
  return {
    port,
    warnings: () => [...(failure === null ? [] : [failure]), ...(withheldSome ? [PRIVATE_NAME_WARNING] : [])],
  };
}

/** The strategy for a merge tool, looked up by own property so a name like "constructor" finds nothing. */
function strategyFor(name: string): MergeFn | undefined {
  for (const table of [searchStrategies, objectStrategies, xrefStrategies] as Readonly<Record<string, MergeFn>>[]) {
    if (Object.hasOwn(table, name)) return table[name];
  }
  return undefined;
}

/** Adds the warnings a result does not already say (a strategy may have noticed the same failure). */
function addMissingWarnings(result: CallToolResult, warnings: readonly string[]): CallToolResult {
  const known = warningsOf(result);
  const missing = warnings.filter((warning) => {
    const kind = warning.split(':')[0];
    return !known.some((entry) => entry.startsWith(kind));
  });
  return withWarnings(result, missing);
}

async function runMerge(name: string, args: Record<string, unknown>, ctx: RouteContext): Promise<CallToolResult> {
  const strategy = strategyFor(name);
  if (!ctx.local.has(name) || !strategy) return forwardOnly(name, args, ctx);
  const checked = parseLocally(name, args, ctx);
  if ('rejected' in checked) return checked.rejected;
  await ctx.localIndex.ensureFresh();

  const hosted = guardUpstream(args, ctx);
  try {
    const result = await strategy(checked.parsed, { ...ctx, upstream: hosted.port }, args);
    return addMissingWarnings(result, hosted.warnings());
  } catch (error) {
    // The hosted leg failed or was withheld and the strategy did not cope (or the strategy itself broke):
    // the plain local handler still gives the developer what the custom index knows.
    const warnings = hosted.warnings();
    const local = await ctx.local.call(name, checked.parsed);
    return withWarnings(local, warnings.length > 0 ? warnings : [`merge failed: ${failureReason(error)}`]);
  }
}

/** A merge tool whose hosted schema differs from the local one: hosted answer only, with a warning. */
async function runSkewed(name: string, args: Record<string, unknown>, ctx: RouteContext): Promise<CallToolResult> {
  const result = await forwardOnly(name, args, ctx);
  if (result.isError) return result;
  return withWarnings(result, [
    `${name} takes different arguments on the hosted server than in this gateway; the call was forwarded without merging local results`,
  ]);
}

/**
 * Runs one tools/call and always resolves: a failure becomes a short isError result without secrets or
 * absolute paths. Local-only tools never reach the hosted server; owner-routed tools go there only when
 * the named object is not in the local index; merge tools ask both sides and degrade to the local side;
 * everything else is forwarded as received. A call whose arguments contain a private name is never sent upstream.
 */
export async function executeToolCall(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: RouteContext
): Promise<CallToolResult> {
  try {
    const args = argsOf(rawArgs);
    switch (routeFor(name)) {
      case 'local':
        return await runLocal(name, args, ctx);
      case 'owner':
        return await runOwner(name, args, ctx);
      case 'merge':
        return ctx.skewedTools.has(name) ? await runSkewed(name, args, ctx) : await runMerge(name, args, ctx);
      case 'forward':
        return await forwardOnly(name, args, ctx);
    }
  } catch (error) {
    const reason = failureReason(error);
    logger.warn('Gateway tool call failed', { tool: name, reason });
    return errorResult(`The gateway could not complete this call: ${reason}`);
  }
}
