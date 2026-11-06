/**
 * DatAscend (qa2) – Login
 * Los casos de Settings › Profile Preferences viven en tests/settings/settings.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEL, login, newIsolatedPage, startBrowser, waitUntil, type Browser } from './support/datascend';

let b: Browser;

beforeAll(async () => {
  b = await startBrowser();
});

afterAll(async () => {
  await b?.stop();
});

describe('Login', () => {
  it('inicia sesión con credenciales válidas y redirige al dashboard', async () => {
    const { page } = await newIsolatedPage(b);
    await login(page);
    expect(await page.url()).toContain('/dashboard');
    expect(await page.evaluate<boolean>(`!!localStorage.getItem('token')`)).toBe(true);
  });

  it('rechaza un usuario inexistente y permanece en /auth/login', async () => {
    const { page } = await newIsolatedPage(b);
    await waitUntil(page, `document.querySelector('${SEL.email}')`);
    await page.evaluate(`(() => {
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (...a) {
        this.addEventListener('load', () => { if (this.responseURL.includes('/users/login')) window.__loginStatus = this.status; });
        return send.apply(this, a);
      };
    })()`);
    // Usuario inexistente a propósito: no suma intentos fallidos a la cuenta real.
    await page.find(SEL.email).fill(`no-existe-${Date.now()}@example.com`);
    await page.find(SEL.password).fill('Incorrecta123!');
    await page.find(SEL.submit).click();
    await waitUntil(page, 'window.__loginStatus');
    const status = await page.evaluate<number>('window.__loginStatus');

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(await page.url()).toContain('/auth/login');
    expect(await page.evaluate<string | null>(`localStorage.getItem('token')`)).toBeFalsy();
  });

  it('la API de login responde 404 para un usuario inexistente', async () => {
    // Comportamiento actual de DatAscend (POST /api/v1/users/login):
    //   - email no registrado            → 404
    //   - email registrado + clave mala  → 401 "login.mismatch"
    // Este test acepta el 404 como comportamiento esperado de la API.
    // Nota de seguridad: al distinguir 404/401 la API permite saber qué emails están registrados
    // (enumeración de usuarios); queda documentado como riesgo conocido, no se valida aquí.
    // Se prueba solo por API y con un email inexistente para no sumar intentos fallidos a la cuenta real.
    const { page } = await newIsolatedPage(b);
    const status = await page.evaluate<number>(`fetch('/api/v1/users/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'no-existe-${Date.now()}@example.com', password: 'Incorrecta123!' }),
    }).then(r => r.status)`);
    expect(status).toBe(404);
  });
});
