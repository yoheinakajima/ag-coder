import type { UseQueryOptions } from "@tanstack/react-query";

/**
 * Helper for passing partial query options to the generated React Query hooks.
 *
 * The Orval-generated hooks type their `query` option as the full
 * `UseQueryOptions`, which (under TanStack Query v5) makes `queryKey` a required
 * field — even though each hook already supplies a sensible default `queryKey`
 * internally. That forced call sites to cast option objects with `as any`.
 *
 * `queryConfig` centralizes that single cast in one type-safe place. When used
 * where a hook expects `UseQueryOptions<TData, TError>`, the generic `TData`/
 * `TError` are inferred from the surrounding contextual type, so the argument is
 * still fully checked against the real option shape (minus the redundant
 * `queryKey`).
 */
export function queryConfig<TData, TError = unknown>(
  options: Omit<UseQueryOptions<TData, TError, TData>, "queryKey">,
): UseQueryOptions<TData, TError, TData> {
  return options as UseQueryOptions<TData, TError, TData>;
}
