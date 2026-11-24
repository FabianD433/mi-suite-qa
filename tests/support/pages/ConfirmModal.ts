/**
 * Page Object del modal de confirmación de Bootstrap abierto (`.modal.show`).
 *
 * Centraliza los selectores y acciones que antes estaban duplicados en `U.modal*`
 * (tests/users/users.spec.ts: borrar/activar usuario) y `N.modal` (tests/notifications/
 * notifications.spec.ts: borrar una notificación / Delete All). Solo puede haber un modal abierto a
 * la vez, así que el Page Object no necesita un selector raíz propio.
 */
import { evalJson, waitUntil, type Page } from '../datascend';

const ROOT = '.modal.show';
const FOOTER = `${ROOT} .modal-footer`;

export const MODAL_SEL = {
  root: ROOT,
  title: `${ROOT} .modal-title`,
  body: `${ROOT} .modal-body`,
  footer: FOOTER,
  /** Botón de acción del pie: rojo (borrar) o verde (activar). */
  confirm: `${FOOTER} .btn-danger, ${FOOTER} .btn-success`,
  danger: `${FOOTER} .btn-danger`,
  success: `${FOOTER} .btn-success`,
  cancel: `${FOOTER} .btn-secondary`,
} as const;

export interface WaitForVisibleOptions {
  /** Selector que debe existir además del modal (p. ej. el botón de acción). */
  ready?: string;
  /** Texto que debe contener el cuerpo (p. ej. para esperar a que esté traducido). */
  bodyIncludes?: string;
  timeout?: number;
}

export class ConfirmModal {
  static readonly SEL = MODAL_SEL;

  constructor(protected readonly page: Page) {}

  async isOpen(): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${ROOT}')`);
  }

  /** Espera a que haya un modal abierto (aún puede estar en la transición de entrada). */
  async waitForOpen(timeout?: number): Promise<void> {
    await waitUntil(this.page, `document.querySelector('${ROOT}')`, timeout);
  }

  /**
   * Espera a que el modal sea visible del todo (fin del fade: opacidad 1) y, opcionalmente, a que
   * exista `ready` y el cuerpo contenga `bodyIncludes`.
   */
  async waitForVisible(opts: WaitForVisibleOptions = {}): Promise<void> {
    const conds = [`document.querySelector('${ROOT}')`];
    if (opts.ready) conds.push(`document.querySelector('${opts.ready}')`);
    conds.push(`getComputedStyle(document.querySelector('${ROOT}')).opacity === '1'`);
    if (opts.bodyIncludes) {
      conds.push(`document.querySelector('${MODAL_SEL.body}')?.innerText.includes(${JSON.stringify(opts.bodyIncludes)})`);
    }
    await waitUntil(this.page, conds.join(' && '), opts.timeout);
  }

  /** Espera a que el modal se cierre (sin `.modal.show`). */
  async waitForClosed(timeout?: number): Promise<void> {
    await waitUntil(this.page, `!document.querySelector('${ROOT}')`, timeout);
  }

  async title(): Promise<string> {
    return this.page.find(MODAL_SEL.title).text();
  }

  async body(): Promise<string> {
    return this.page.find(MODAL_SEL.body).text();
  }

  /** Texto del cuerpo y de su parte en negrita (p. ej. el nombre del usuario). */
  async bodyWithBold(): Promise<{ body: string; bold: string }> {
    return evalJson(
      this.page,
      `{ body: document.querySelector('${MODAL_SEL.body}').innerText.trim(),
         bold: document.querySelector('${MODAL_SEL.body} strong')?.innerText.trim() }`,
    );
  }

  /** Texto de un botón del pie (por defecto, el de acción). */
  async buttonText(button: 'confirm' | 'danger' | 'success' | 'cancel' = 'confirm'): Promise<string> {
    return this.page.find(MODAL_SEL[button]).text();
  }

  /** Pulsa el botón de acción (rojo o verde). No espera al cierre: la acción puede tardar. */
  async confirm(): Promise<void> {
    await this.page.find(MODAL_SEL.confirm).click();
  }

  /** Pulsa un botón concreto del pie (p. ej. 'success' para "Activate"). No espera al cierre. */
  async press(button: 'danger' | 'success'): Promise<void> {
    await this.page.find(MODAL_SEL[button]).click();
  }

  /** Pulsa "Cancel" y espera a que el modal se cierre y termine su transición. */
  async cancel(): Promise<void> {
    await this.page.find(MODAL_SEL.cancel).click();
    await this.waitForClosed();
    await this.page.wait(400);
  }
}
