/** Single source for the app version, read from package.json at build time via resolveJsonModule-free import. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let cached: string | undefined;

/** App version from package.json; works both under tsx (repo layout) and from dist/. */
export function appVersion(): string {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [here, path.dirname(here), path.dirname(path.dirname(here))]) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        version?: string;
      };
      if (pkg.version) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // try next candidate directory
    }
  }
  cached = '0.0.0';
  return cached;
}
