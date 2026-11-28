/**
 * @aureliajs/ssr Rich JSON Codec
 *
 * Zero-dependency, strict-CSP-safe structured JSON table encoder/decoder.
 * Preserves Date, Map, Set, BigInt, RegExp, URL, special numbers (-0, NaN, +-Infinity),
 * undefined array/collection elements, and shared/circular object references inside
 * standard `<script type="application/json">` payloads without inline JS execution.
 */

import {
  claimDeferredPromise,
  getDeferredRegistry,
  type DeferredRegistry,
} from './deferred';
import type { DecodeRichOptions, EncodeRichOptions } from './types';

const TAG_UNDEF = '$u';
const TAG_NUM = '$n';
const TAG_BIGINT = '$b';
const TAG_DATE = '$d';
const TAG_REGEXP = '$r';
const TAG_URL = '$l';
const TAG_SET = '$s';
const TAG_MAP = '$m';
const TAG_PROMISE = '$p';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPromiseLike(value: object): value is Promise<unknown> {
  return (
    value instanceof Promise ||
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function encodeRichValue(
  rootValue: unknown,
  replacerOrOptions?: ((key: string, value: unknown) => unknown) | EncodeRichOptions,
  maybeOptions?: EncodeRichOptions
): unknown[] {
  const options =
    typeof replacerOrOptions === 'object' && replacerOrOptions !== null
      ? replacerOrOptions
      : maybeOptions;
  const replacer =
    typeof replacerOrOptions === 'function' ? replacerOrOptions : options?.replacer;
  const onPromise = options?.onPromise;

  const table: unknown[] = [];
  const memo = new Map<object, number>();

  function add(key: string, rawVal: unknown, alreadyReplaced = false): number {
    const val = alreadyReplaced ? rawVal : replacer ? replacer(key, rawVal) : rawVal;

    if (val === undefined || typeof val === 'function' || typeof val === 'symbol') {
      const idx = table.length;
      table.push([TAG_UNDEF]);
      return idx;
    }

    if (val === null || typeof val === 'boolean' || typeof val === 'string') {
      const idx = table.length;
      table.push(val);
      return idx;
    }

    if (typeof val === 'number') {
      const idx = table.length;
      if (Number.isNaN(val)) {
        table.push([TAG_NUM, 'NaN']);
      } else if (val === Infinity) {
        table.push([TAG_NUM, 'Infinity']);
      } else if (val === -Infinity) {
        table.push([TAG_NUM, '-Infinity']);
      } else if (Object.is(val, -0)) {
        table.push([TAG_NUM, '-0']);
      } else {
        table.push(val);
      }
      return idx;
    }

    if (typeof val === 'bigint') {
      const idx = table.length;
      table.push([TAG_BIGINT, val.toString()]);
      return idx;
    }

    if (typeof val === 'object') {
      const existing = memo.get(val);
      if (existing !== undefined) {
        return existing;
      }

      const idx = table.length;
      table.push(null);
      memo.set(val, idx);

      if (isPromiseLike(val)) {
        table[idx] = onPromise ? [TAG_PROMISE, onPromise(val)] : [TAG_UNDEF];
        return idx;
      }

      if (val instanceof Date) {
        table[idx] = [TAG_DATE, Number.isNaN(val.getTime()) ? 'NaN' : val.toISOString()];
        return idx;
      }

      if (val instanceof RegExp) {
        table[idx] = [TAG_REGEXP, val.source, val.flags];
        return idx;
      }

      if (val instanceof URL) {
        table[idx] = [TAG_URL, val.href];
        return idx;
      }

      if (val instanceof Set) {
        const items: number[] = [];
        let i = 0;
        for (const item of val) {
          items.push(add(String(i++), item));
        }
        table[idx] = [TAG_SET, items];
        return idx;
      }

      if (val instanceof Map) {
        const entries: Array<[number, number]> = [];
        let i = 0;
        for (const [k, v] of val.entries()) {
          entries.push([add(`k${i}`, k), add(`v${i}`, v)]);
          i++;
        }
        table[idx] = [TAG_MAP, entries];
        return idx;
      }

      if (Array.isArray(val)) {
        table[idx] = val.map((item, i) => add(String(i), item));
        return idx;
      }

      const record: Record<string, number> = {};
      for (const [propKey, propVal] of Object.entries(val)) {
        if (FORBIDDEN_KEYS.has(propKey)) continue;
        if (typeof propVal === 'function' || typeof propVal === 'symbol') continue;
        const filtered = replacer ? replacer(propKey, propVal) : propVal;
        if (filtered === undefined) continue;
        record[propKey] = add(propKey, filtered, true);
      }
      table[idx] = record;
      return idx;
    }

    const idx = table.length;
    table.push([TAG_UNDEF]);
    return idx;
  }

  add('', rootValue);
  return table;
}

function isRefIndex(value: unknown, len: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < len;
}

/**
 * Decodes a reference table defensively. Malformed or truncated payloads yield
 * `undefined` for the affected values instead of throwing during hydration.
 */
export function decodeRichValue<T = unknown>(
  table: unknown,
  options?: DecodeRichOptions
): T {
  if (!Array.isArray(table) || table.length === 0) {
    return undefined as T;
  }

  const len = table.length;
  const resolved: unknown[] = Array.from({ length: len });
  const registry: DeferredRegistry = getDeferredRegistry(options?.root);
  const localDeferred = new Map<string, Promise<unknown>>();

  // Pass 1: instantiate leaf values and empty container shells for cycle safety
  for (let i = 0; i < len; i++) {
    const entry = table[i];
    if (entry === null || typeof entry !== 'object') {
      resolved[i] = entry;
      continue;
    }

    if (Array.isArray(entry)) {
      const tag = entry[0];
      if (tag === TAG_UNDEF && entry.length === 1) {
        resolved[i] = undefined;
      } else if (tag === TAG_NUM && entry.length === 2) {
        const raw = entry[1];
        resolved[i] =
          raw === 'NaN'
            ? Number.NaN
            : raw === 'Infinity'
              ? Infinity
              : raw === '-Infinity'
                ? -Infinity
                : raw === '-0'
                  ? -0
                  : Number(raw);
      } else if (tag === TAG_BIGINT && typeof entry[1] === 'string') {
        try {
          resolved[i] = BigInt(entry[1]);
        } catch {
          resolved[i] = undefined;
        }
      } else if (tag === TAG_DATE && typeof entry[1] === 'string') {
        resolved[i] = entry[1] === 'NaN' ? new Date(Number.NaN) : new Date(entry[1]);
      } else if (tag === TAG_REGEXP && typeof entry[1] === 'string') {
        try {
          resolved[i] = new RegExp(entry[1], typeof entry[2] === 'string' ? entry[2] : '');
        } catch {
          resolved[i] = undefined;
        }
      } else if (tag === TAG_URL && typeof entry[1] === 'string') {
        try {
          resolved[i] = new URL(entry[1]);
        } catch {
          resolved[i] = undefined;
        }
      } else if (tag === TAG_PROMISE) {
        if (typeof entry[1] === 'string') {
          const id = entry[1];
          let promise = localDeferred.get(id);
          if (!promise) {
            promise = options?.resolvePromise
              ? options.resolvePromise(id)
              : claimDeferredPromise(id, registry);
            localDeferred.set(id, promise);
          }
          resolved[i] = promise;
        } else {
          resolved[i] = undefined;
        }
      } else if (tag === TAG_SET && Array.isArray(entry[1])) {
        resolved[i] = new Set();
      } else if (tag === TAG_MAP && Array.isArray(entry[1])) {
        resolved[i] = new Map();
      } else {
        // A corrupted table must not allocate an unbounded array.
        resolved[i] = Array.from({ length: Math.min(entry.length, len) });
      }
      continue;
    }

    resolved[i] = {};
  }

  // Pass 2: link container references
  for (let i = 0; i < len; i++) {
    const entry = table[i];
    if (entry === null || typeof entry !== 'object') continue;

    if (Array.isArray(entry)) {
      const tag = entry[0];
      if (
        tag === TAG_UNDEF ||
        tag === TAG_NUM ||
        tag === TAG_BIGINT ||
        tag === TAG_DATE ||
        tag === TAG_REGEXP ||
        tag === TAG_URL ||
        tag === TAG_PROMISE
      ) {
        continue;
      }

      if (tag === TAG_SET && Array.isArray(entry[1])) {
        const target = resolved[i] as Set<unknown>;
        for (const itemIdx of entry[1]) {
          if (isRefIndex(itemIdx, len)) {
            target.add(resolved[itemIdx]);
          }
        }
        continue;
      }

      if (tag === TAG_MAP && Array.isArray(entry[1])) {
        const target = resolved[i] as Map<unknown, unknown>;
        for (const pair of entry[1]) {
          if (Array.isArray(pair) && isRefIndex(pair[0], len) && isRefIndex(pair[1], len)) {
            target.set(resolved[pair[0]], resolved[pair[1]]);
          }
        }
        continue;
      }

      const arr = resolved[i] as unknown[];
      for (let j = 0; j < arr.length; j++) {
        const refIdx = entry[j];
        arr[j] = isRefIndex(refIdx, len) ? resolved[refIdx] : undefined;
      }
      continue;
    }

    const obj = resolved[i] as Record<string, unknown>;
    for (const [k, refIdx] of Object.entries(entry as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if (isRefIndex(refIdx, len)) {
        obj[k] = resolved[refIdx];
      }
    }
  }

  return resolved[0] as T;
}
