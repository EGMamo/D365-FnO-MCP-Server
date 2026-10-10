/** Default cap on each list a detail tool returns (fields, methods, controls, ...). */
export const DEFAULT_MAX_ITEMS = 1000;

export interface TruncationInfo {
  returned: number;
  total: number;
}

/**
 * Caps the named array properties of `value` at `max` items each. The shape is unchanged unless a
 * list is cut, in which case a `truncated` map reports returned/total per list so callers can
 * tell a short result from a clipped one.
 */
export function capLists<T extends object>(value: T, keys: readonly (keyof T & string)[], max: number): T & { truncated?: Record<string, TruncationInfo> } {
  const out = { ...value } as Record<string, unknown>;
  const truncated: Record<string, TruncationInfo> = {};
  for (const key of keys) {
    const list = out[key];
    if (Array.isArray(list) && list.length > max) {
      truncated[key] = { returned: max, total: list.length };
      out[key] = list.slice(0, max);
    }
  }
  if (Object.keys(truncated).length > 0) out.truncated = truncated;
  return out as T & { truncated?: Record<string, TruncationInfo> };
}
