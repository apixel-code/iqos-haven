import type { PermissionKey } from "./permissions";

/**
 * Response field policy (architecture §11: "services enforce field and object scope … strip
 * forbidden aggregate fields from responses"). A policy names the fields that need a permission
 * beyond the route's own; every other field is governed by the route permission and the
 * response contract. Nested objects and arrays of objects are described by a nested policy.
 *
 * Example: `{ lifetimeSpendFils: "customers.financial_read", orders: { revenueFils: "dashboard.financial_read" } }`
 */
export type FieldPolicy = { readonly [field: string]: PermissionKey | FieldPolicy };

export function defineFieldPolicy<const P extends FieldPolicy>(policy: P): P {
  return policy;
}

/** Every permission a policy mentions, for checks that the catalogue still knows them. */
export function fieldPolicyPermissions(policy: FieldPolicy): PermissionKey[] {
  const keys = new Set<PermissionKey>();
  for (const rule of Object.values(policy)) {
    if (typeof rule === "string") keys.add(rule);
    else for (const key of fieldPolicyPermissions(rule)) keys.add(key);
  }
  return [...keys];
}

/**
 * Returns a copy of `value` without the fields the holder of `permissions` may not read.
 * Arrays are filtered element by element; the input is never mutated. A denied field is removed
 * (not nulled) so a response does not even reveal that the aggregate exists.
 */
export function filterFields<T>(
  value: T,
  policy: FieldPolicy,
  permissions: ReadonlySet<string>,
): T {
  return filter(value, policy, permissions) as T;
}

function filter(value: unknown, policy: FieldPolicy, permissions: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => filter(item, policy, permissions));
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const rule = Object.hasOwn(policy, key) ? policy[key] : undefined;
    if (rule === undefined) result[key] = field;
    else if (typeof rule === "string") {
      if (permissions.has(rule)) result[key] = field;
    } else result[key] = filter(field, rule, permissions);
  }
  return result;
}
