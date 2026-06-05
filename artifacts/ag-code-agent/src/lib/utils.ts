import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export type UnknownRecord = Record<string, unknown>;

/** Narrow an unknown value to a plain record, or undefined if it isn't one. */
export function asRecord(v: unknown): UnknownRecord | undefined {
  return v != null && typeof v === "object" ? (v as UnknownRecord) : undefined;
}

/** Return the value if it is a string, otherwise undefined. */
export function strField(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Return the value if it is a number, otherwise undefined. */
export function numField(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
