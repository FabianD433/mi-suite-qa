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

  it('usuario inexistente y contraseña incorrecta devuelven la misma respuesta (sin enumeración de usuarios)', async () => {
    // Hallazgo: qa2 responde 404 para un email inexistente y 401 "login.mismatch" para contraseña
    // incorrecta, lo que permite saber qué emails están registrados. Se compara solo por API y
    // con un email inexistente para no sumar intentos fallidos a la cuenta real.
    const { page } = await newIsolatedPage(b);
    const status = await page.evaluate<number>(`fetch('/api/v1/users/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'no-existe-${Date.now()}@example.com', password: 'Incorrecta123!' }),
    }).then(r => r.status)`);
    expect(status).toBe(401);
  });
});
