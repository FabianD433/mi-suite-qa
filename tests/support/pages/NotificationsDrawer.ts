/**
 * Page Object del panel de notificaciones: campana de la cabecera, drawer (offcanvas) con sus ítems
 * y las acciones Dismiss / Delete / Dismiss All / Delete All.
 *
 * Extraído de tests/notifications/notifications.spec.ts (`N.*`, `openDrawer`, `closeDrawerWithX`,
 * `layoutState`, `renderedItems`). Los modales de confirmación son ConfirmModal.
 */
import { evalJson, waitUntil, type Page } from '../datascend';
import { SHELL_SEL } from './AppShell';
import { ConfirmModal } from './ConfirmModal';

const DRAWER = '[data-testid="notifications.drawer"]';
const ITEM = '[data-testid="notifications.item"]';

export const NOTIF_SEL = {
  bell: SHELL_SEL.notificationsBell,
  /** Contador de no leídas sobre la campana. */
  headerBadge: '[data-testid="notifications.badge"]',
  drawer: DRAWER,
  drawerOpen: `${DRAWER}.show`,
  drawerTitle: `${DRAWER} .offcanvas-title strong`,
  /** Contador de no leídas en la cabecera del drawer. */
  drawerBadge: '[data-testid="notifications.drawer.badge"]',
  dismissAll: '[data-testid="notifications.dismiss-all"]',
  deleteAll: '[data-testid="notifications.delete-all-btn"]',
  close: '[data-testid="notifications.close"]',
  /** Contenedor con scroll de los ítems (o del texto "No notifications"). */
  body: '[data-testid="notifications.body"]',
  item: ITEM,
  itemBody: `${ITEM} .notification-body`,
  dismissBtn: '[data-testid="notifications.dismiss-btn"]',
  deleteBtn: '[data-testid="notifications.delete-btn"]',
  enablePush: `${DRAWER} .notification-actions .btn-outline-primary`,
  /** Ítem de una notificación concreta. */
  itemOf: (id: string) => `[data-testitemid="notifications.item.${id}"]`,
} as const;

/** Texto del estado vacío (/locales/en/translation.json → notifications). */
const EMPTY_TEXT = 'No notifications';

export interface NotificationItem {
  id: string;
  unread: boolean;
  sender: string;
  body: string;
  /** Tooltip del cuerpo (texto completo). */
  title: string | null;
  date: string;
  hasDismiss: boolean;
  hasDelete: boolean;
}

export interface LayoutState {
  drawerOpen: boolean;
  backdrops: number;
  bodyOverflow: string;
  /** top, left, width, height de la cabecera. */
  header: number[];
}

export class NotificationsDrawer {
  static readonly SEL = NOTIF_SEL;
  static readonly EMPTY_TEXT = EMPTY_TEXT;

  constructor(private readonly page: Page) {}

  async waitForBell(timeout?: number): Promise<void> {
    await waitUntil(this.page, `document.querySelector('${NOTIF_SEL.bell}')`, timeout);
  }

  async isOpen(): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${NOTIF_SEL.drawerOpen}')`);
  }

  /** Pulsa la campana y espera a que el drawer esté abierto (sin esperar a la carga de ítems). */
  async clickBell(): Promise<void> {
    await this.page.find(NOTIF_SEL.bell).click();
    await waitUntil(this.page, `document.querySelector('${NOTIF_SEL.drawerOpen}')`);
  }

  /** Abre el drawer con la campana y espera a que termine la carga (ítems o estado vacío). */
  async open(): Promise<void> {
    await this.clickBell();
    await waitUntil(
      this.page,
      `document.querySelector('${ITEM}') || document.querySelector('${NOTIF_SEL.body}')?.innerText.includes('${EMPTY_TEXT}')`,
      15_000,
    );
    await this.page.wait(500);
  }

  /** Cierra el drawer con la X y espera a que termine la transición del offcanvas. */
  async closeWithX(): Promise<void> {
    await this.page.find(NOTIF_SEL.close).click();
    await this.waitForClosed();
  }

  /** Cierra el drawer pulsando de nuevo la campana. */
  async closeWithBell(): Promise<void> {
    await this.page.find(NOTIF_SEL.bell).click();
    await this.waitForClosed();
  }

  private async waitForClosed(): Promise<void> {
    await waitUntil(this.page, `!document.querySelector('${NOTIF_SEL.drawerOpen}')`);
    await this.page.wait(500); // transición del offcanvas
  }

  /** Estado de la UI: drawer, backdrops, scroll del body y posición de la cabecera. */
  async layoutState(): Promise<LayoutState> {
    return evalJson<LayoutState>(
      this.page,
      `(() => { const h = document.querySelector('${SHELL_SEL.header}').getBoundingClientRect();
        return { drawerOpen: !!document.querySelector('${NOTIF_SEL.drawerOpen}'),
          backdrops: document.querySelectorAll('.offcanvas-backdrop, .modal-backdrop').length,
          bodyOverflow: document.body.style.overflow,
          header: [h.top, h.left, h.width, h.height].map(Math.round) }; })()`,
    );
  }

  // ── Lectura ────────────────────────────────────────────────────────────────────

  async title(): Promise<string> {
    return this.page.find(NOTIF_SEL.drawerTitle).text();
  }

  /** Ítems renderizados en el drawer, en orden. */
  async items(): Promise<NotificationItem[]> {
    return evalJson<NotificationItem[]>(
      this.page,
      `[...document.querySelectorAll('${ITEM}')].map(e => ({
        id: e.dataset.testitemid.replace('notifications.item.', ''),
        unread: e.classList.contains('unread'),
        sender: e.querySelector('.notification-sender')?.innerText.trim() ?? '',
        body: e.querySelector('.notification-body')?.innerText.trim() ?? '',
        title: e.querySelector('.notification-body')?.getAttribute('title'),
        date: e.querySelector('.notification-date')?.innerText.trim() ?? '',
        hasDismiss: !!e.querySelector('${NOTIF_SEL.dismissBtn}'),
        hasDelete: !!e.querySelector('${NOTIF_SEL.deleteBtn}'),
      }))`,
    );
  }

  async itemCount(): Promise<number> {
    return this.page.evaluate<number>(`document.querySelectorAll('${ITEM}').length`);
  }

  /** Texto del cuerpo de una notificación. */
  async itemBody(id: string): Promise<string> {
    return this.page.find(`${NOTIF_SEL.itemOf(id)} .notification-body`).text();
  }

  /** Texto del contenedor de ítems (p. ej. "No notifications" cuando está vacío). */
  async bodyText(): Promise<string> {
    return this.page.find(NOTIF_SEL.body).text();
  }

  /** ¿Existe el elemento `key` del drawer/cabecera? (p. ej. 'dismissAll', 'headerBadge'). */
  async has(key: 'dismissAll' | 'deleteAll' | 'headerBadge' | 'drawerBadge' | 'enablePush'): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${NOTIF_SEL[key]}')`);
  }

  /** Espera a que desaparezca el contador de la campana (o muestre 0 / vacío). */
  async waitForHeaderBadgeCleared(timeout?: number): Promise<void> {
    await waitUntil(
      this.page,
      `!document.querySelector('${NOTIF_SEL.headerBadge}') || /^0?$/.test(document.querySelector('${NOTIF_SEL.headerBadge}').innerText.trim())`,
      timeout,
    );
  }

  /** Lleva el scroll del contenedor de ítems al final (dispara la carga de la página siguiente). */
  async scrollToBottom(): Promise<void> {
    await this.page.evaluate(`(() => { const b = document.querySelector('${NOTIF_SEL.body}'); b.scrollTop = b.scrollHeight; })()`);
    await waitUntil(this.page, `document.querySelector('${NOTIF_SEL.body}').scrollTop > 0`);
  }

  /** Espera a que haya más de `count` ítems renderizados. */
  async waitForMoreItemsThan(count: number, timeout = 10_000): Promise<void> {
    await waitUntil(this.page, `document.querySelectorAll('${ITEM}').length > ${count}`, timeout);
  }

  // ── Acciones ───────────────────────────────────────────────────────────────────

  /** Pulsa "Dismiss" en una notificación (no espera la respuesta). */
  async dismiss(id: string): Promise<void> {
    await this.page.find(`${NOTIF_SEL.itemOf(id)} ${NOTIF_SEL.dismissBtn}`).click();
  }

  /** Espera a que la notificación aparezca como leída. */
  async waitForRead(id: string): Promise<void> {
    await waitUntil(this.page, `document.querySelector('${NOTIF_SEL.itemOf(id)}').classList.contains('read')`);
  }

  /** ¿La notificación sigue mostrando "Dismiss"? */
  async hasDismissButton(id: string): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${NOTIF_SEL.itemOf(id)} ${NOTIF_SEL.dismissBtn}')`);
  }

  /** Pulsa la papelera de una notificación y devuelve el modal de confirmación ya abierto. */
  async delete(id: string): Promise<ConfirmModal> {
    await this.page.find(`${NOTIF_SEL.itemOf(id)} ${NOTIF_SEL.deleteBtn}`).click();
    return this.openedModal();
  }

  async waitForItemGone(id: string, timeout?: number): Promise<void> {
    await waitUntil(this.page, `!document.querySelector('${NOTIF_SEL.itemOf(id)}')`, timeout);
  }

  /** Pulsa "Dismiss All" (no espera la respuesta). */
  async dismissAll(): Promise<void> {
    await this.page.find(NOTIF_SEL.dismissAll).click();
  }

  async dismissAllText(): Promise<string> {
    return this.page.find(NOTIF_SEL.dismissAll).text();
  }

  /** Pulsa "Delete All" y devuelve el modal de confirmación ya abierto. */
  async deleteAll(): Promise<ConfirmModal> {
    await this.page.find(NOTIF_SEL.deleteAll).click();
    return this.openedModal();
  }

  /** Pulsa "Enable Push Notifications". */
  async enablePush(): Promise<void> {
    await this.page.find(NOTIF_SEL.enablePush).click();
  }

  async enablePushTooltip(): Promise<string | null> {
    return this.page.find(NOTIF_SEL.enablePush).attr('data-tooltip');
  }

  private async openedModal(): Promise<ConfirmModal> {
    const modal = new ConfirmModal(this.page);
    await modal.waitForOpen();
    return modal;
  }
}
