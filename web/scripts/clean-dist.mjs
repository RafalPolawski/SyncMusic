// Empties the Go embed directory before a build while keeping .gitkeep, so
// stale hashed assets never end up in the binary.
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../../internal/webui/dist/', import.meta.url));
for (const entry of readdirSync(dist)) {
  if (entry !== '.gitkeep') rmSync(dist + entry, { recursive: true, force: true });
}
