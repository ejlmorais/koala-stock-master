#!/usr/bin/env node
/**
 * Cria (ou atualiza) o esquema "v2" a partir de scripts/v2/schema.sql.
 *
 *   node scripts/v2/setup.mjs          # mostra os statements, não executa
 *   node scripts/v2/setup.mjs --apply  # executa na base de dados
 *
 * Lê DATABASE_URL de .env.local / .env. Idempotente.
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

const APPLY = process.argv.includes('--apply');
const text = readFileSync(join(root, 'scripts', 'v2', 'schema.sql'), 'utf8');

// Um statement por ';' no fim de linha; comentários removidos.
const statements = text
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`${statements.length} statements${APPLY ? '' : ' (dry run; usa --apply para executar)'}`);

if (!APPLY) {
  for (const s of statements) console.log('•', s.split('\n')[0].slice(0, 90));
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definido.');
  process.exit(1);
}
const sql = neon(url);
for (const s of statements) {
  await sql.query(s);
  console.log('✔', s.split('\n')[0].slice(0, 90));
}
console.log('Esquema v2 pronto.');
