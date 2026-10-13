import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function getAllSourceFiles(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist') {
        getAllSourceFiles(fullPath, fileList);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

describe('Architectural & Boundary Enforcement', () => {
  const packageSrc = path.resolve(__dirname, '../src');
  const allFiles = getAllSourceFiles(packageSrc);

  it('no package source file imports from Undone host (@/src or relative host paths)', () => {
    const violations: { file: string; line: string }[] = [];

    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (/from\s+['"]@\//.test(line) || /from\s+['"]\.\.\/\.\.\/\.\.\/src/.test(line)) {
          violations.push({ file, line: line.trim() });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('generic core and runtime do NOT import from "ai" SDK', () => {
    const coreAndRuntimeFiles = allFiles.filter(f => {
      const rel = path.relative(packageSrc, f).replace(/\\/g, '/');
      return rel.startsWith('core/') || rel.startsWith('runtime/');
    });

    const violations: { file: string; line: string }[] = [];
    for (const file of coreAndRuntimeFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (/from\s+['"]ai['"]/.test(line) || /from\s+['"]ai\//.test(line)) {
          violations.push({ file, line: line.trim() });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('generic core and runtime do NOT import from adapters', () => {
    const coreAndRuntimeFiles = allFiles.filter(f => {
      const rel = path.relative(packageSrc, f).replace(/\\/g, '/');
      return rel.startsWith('core/') || rel.startsWith('runtime/');
    });

    const violations: { file: string; line: string }[] = [];
    for (const file of coreAndRuntimeFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (/from\s+['"].*adapters(\/|['"])/.test(line)) {
          violations.push({ file, line: line.trim() });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('client and core modules do NOT import server libraries (pg, server-only, etc.)', () => {
    const browserFiles = allFiles.filter(f => {
      const rel = path.relative(packageSrc, f).replace(/\\/g, '/');
      return rel.startsWith('core/') || rel.startsWith('client/') || rel.startsWith('react/');
    });

    const violations: { file: string; line: string }[] = [];
    for (const file of browserFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (
          /from\s+['"]pg['"]/.test(line) ||
          /from\s+['"]server-only['"]/.test(line) ||
          /from\s+['"]\.\.\/adapters\/pg/.test(line)
        ) {
          violations.push({ file, line: line.trim() });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
