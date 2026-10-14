/**
 * Lightweight, zero-dependency RFC 6902 JSON Patch generator and applicator.
 * Enables transmitting minimal state deltas over HTTP/SSE instead of full state snapshots.
 */

export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

export type JsonPatch = JsonPatchOperation[];

function escapeJsonPointer(str: string): string {
  return str.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeJsonPointer(str: string): string {
  return str.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`Invalid JSON Pointer: "${path}"`);
  return path.slice(1).split('/').map(unescapeJsonPointer);
}

/**
 * Apply RFC 6902 JSON patch operations immutably to a document.
 */
export function applyJsonPatch<T>(doc: T, patch: JsonPatch): T {
  let root = structuredClone(doc);

  for (const op of patch) {
    const tokens = parsePointer(op.path);

    if (tokens.length === 0) {
      if (op.op === 'replace' || op.op === 'add') {
        root = structuredClone(op.value) as T;
        continue;
      }
      throw new Error(`Cannot perform op "${op.op}" on document root`);
    }

    let parent: any = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      const key = tokens[i]!;
      if (parent === null || typeof parent !== 'object') {
        throw new Error(`Cannot traverse path "${op.path}"`);
      }
      parent = parent[key];
    }

    const lastKey = tokens[tokens.length - 1]!;

    if (op.op === 'add') {
      if (Array.isArray(parent)) {
        const index = lastKey === '-' ? parent.length : Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index > parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for add`);
        }
        parent.splice(index, 0, structuredClone(op.value));
      } else if (parent && typeof parent === 'object') {
        parent[lastKey] = structuredClone(op.value);
      } else {
        throw new Error(`Cannot add to non-object parent at "${op.path}"`);
      }
    } else if (op.op === 'replace') {
      if (Array.isArray(parent)) {
        const index = Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for replace`);
        }
        parent[index] = structuredClone(op.value);
      } else if (parent && typeof parent === 'object') {
        if (!(lastKey in parent)) throw new Error(`Property "${lastKey}" not found for replace`);
        parent[lastKey] = structuredClone(op.value);
      }
    } else if (op.op === 'remove') {
      if (Array.isArray(parent)) {
        const index = Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for remove`);
        }
        parent.splice(index, 1);
      } else if (parent && typeof parent === 'object') {
        if (!(lastKey in parent)) throw new Error(`Property "${lastKey}" not found for remove`);
        delete parent[lastKey];
      }
    } else if (op.op === 'test') {
      const actual = parent?.[lastKey];
      if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
        throw new Error(`Test operation failed at "${op.path}"`);
      }
    } else {
      throw new Error(`Unsupported JSON Patch operation: "${op.op}"`);
    }
  }

  return root;
}

/**
 * Generate minimal RFC 6902 JSON patch operations comparing two plain documents.
 */
export function generateJsonPatch(prev: unknown, next: unknown, basePath = ''): JsonPatch {
  const patch: JsonPatch = [];

  if (prev === next) return patch;

  if (
    prev === null ||
    next === null ||
    typeof prev !== 'object' ||
    typeof next !== 'object' ||
    Array.isArray(prev) !== Array.isArray(next)
  ) {
    patch.push({ op: 'replace', path: basePath, value: next });
    return patch;
  }

  if (Array.isArray(prev) && Array.isArray(next)) {
    // Array diffing: if lengths differ or deep content changes, generate fine-grained index patches
    if (prev.length === next.length) {
      for (let i = 0; i < prev.length; i++) {
        const itemPath = `${basePath}/${i}`;
        patch.push(...generateJsonPatch(prev[i], next[i], itemPath));
      }
    } else {
      // For different lengths, replace the array directly for clean consistency
      patch.push({ op: 'replace', path: basePath, value: next });
    }
    return patch;
  }

  const prevObj = prev as Record<string, unknown>;
  const nextObj = next as Record<string, unknown>;
  const prevKeys = Object.keys(prevObj);
  const nextKeys = Object.keys(nextObj);

  // Removals
  for (const k of prevKeys) {
    if (!(k in nextObj)) {
      patch.push({ op: 'remove', path: `${basePath}/${escapeJsonPointer(k)}` });
    }
  }

  // Additions and updates
  for (const k of nextKeys) {
    const keyPath = `${basePath}/${escapeJsonPointer(k)}`;
    if (!(k in prevObj)) {
      patch.push({ op: 'add', path: keyPath, value: nextObj[k] });
    } else {
      patch.push(...generateJsonPatch(prevObj[k], nextObj[k], keyPath));
    }
  }

  return patch;
}

/**
 * Resolves a JSON Pointer on a document to its target value.
 * Returns undefined if path does not exist.
 */
export function getValueByPointer(doc: unknown, path: string): unknown {
  if (path === '') return doc;
  const tokens = parsePointer(path);
  let current: any = doc;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!(token in current)) return undefined;
    current = current[token];
  }
  return current;
}

/**
 * Computes the inverse of an RFC 6902 JSON patch against the document state before the patch was applied.
 * Applying the inverse patch to the modified document restores the original document state.
 */
export function invertJsonPatch(doc: unknown, patch: JsonPatch): JsonPatch {
  const inverted: JsonPatch = [];
  // Walk operations in reverse order for correct LIFO undo semantics
  for (let i = patch.length - 1; i >= 0; i--) {
    const op = patch[i]!;
    if (op.path === '') {
      inverted.push({ op: 'replace', path: '', value: structuredClone(doc) });
      continue;
    }
    if (op.op === 'add') {
      inverted.push({ op: 'remove', path: op.path });
    } else if (op.op === 'remove') {
      const prevVal = getValueByPointer(doc, op.path);
      inverted.push({ op: 'add', path: op.path, value: structuredClone(prevVal) });
    } else if (op.op === 'replace') {
      const prevVal = getValueByPointer(doc, op.path);
      inverted.push({ op: 'replace', path: op.path, value: structuredClone(prevVal) });
    } else {
      throw new Error(`Unsupported JSON Patch operation for inversion: "${op.op}"`);
    }
  }
  return inverted;
}
