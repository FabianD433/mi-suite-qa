import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carga `.env` de la raíz del proyecto sin dependencias externas.
 * Tolera BOM, CRLF, espacios alrededor del `=` y valores entre comillas.
 * Las variables ya definidas en el entorno tienen prioridad.
 */
export function loadEnv(file = resolve(process.cwd(), '.env')): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name} (ver .env.example)`);
  return value;
}
