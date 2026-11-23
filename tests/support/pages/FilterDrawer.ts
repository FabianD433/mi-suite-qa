/**
 * Page Object del drawer de filtros ("Filters") de los listados de DatAscend (entidades, Users…).
 *
 * Centraliza los selectores que antes estaban repartidos entre `SEL.filter*`
 * (tests/support/datascend.ts) y `U.filter*` (tests/users/users.spec.ts), la lógica de
 * `applyFilter` de users.spec.ts y la espera anti-overlay que estabilizó TC1586.
 */
import { clickUnobscured, waitEnabled, waitForOverlaysClosed, waitUntil, type Page } from '../datascend';
import { TreeSelect } from './TreeSelect';

const DRAWER = '.filter-offcanvas.show';

export const FILTER_SEL = {
  /** Botón del subheader que abre el drawer (su `title` se traduce: "Filters"/"Filtros"). */
  toggle: '[id="filter.toggle"]',
  /** Drawer abierto (offcanvas con `.show`). */
  drawer: DRAWER,
  /** Título "Filters" de la cabecera: zona neutra (sin botones) para cerrar overlays con un clic. */
  title: `${DRAWER} .offcanvas-title > div > div:first-child`,
  closeButton: `${DRAWER} .btn-close`,
  apply: `${DRAWER} [id="filter.drawer.apply"]`,
  clear: `${DRAWER} [id="filter.drawer.clear"]`,
  /** TreeSelect del campo y del operador de la condición. */
  field: `${DRAWER} [id="filter.drawer.condition.field"]`,
  operator: `${DRAWER} [id="filter.drawer.condition.operator"]`,
  /** Chips de filtros activos (fuera del drawer, sobre la tabla). */
  activeFilters: '[id="filter.activeFilters"]',
} as const;

export interface FilterCondition {
  /** Texto del campo en el TreeSelect (p. ej. "Email", "last_name"). */
  field: string;
  /**
   * Operador (p. ej. "Equals to", "Like"). Si se omite se deja el que propone la app.
   * Si la app ya propone ese mismo operador no se vuelve a elegir (evita deseleccionarlo).
   */
  operator?: string;
  /** Valor: texto a escribir, o `value` del radio cuando `input.type` es `'radio'`. */
  value: string;
  /** Input del valor: `name` del campo (por defecto, `field`) y tipo (por defecto, texto). */
  input?: { name?: string; type?: 'text' | 'radio' };
}

export class FilterDrawer {
  static readonly SEL = FILTER_SEL;

  readonly field: TreeSelect;
  readonly operator: TreeSelect;

  constructor(private readonly page: Page) {
    // Un clic en el título cierra el panel del TreeSelect sin cerrar el drawer ni tocar los valores.
    this.field = new TreeSelect(page, FILTER_SEL.field, { dismissTarget: FILTER_SEL.title });
    this.operator = new TreeSelect(page, FILTER_SEL.operator, { dismissTarget: FILTER_SEL.title });
  }

  async isOpen(): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${DRAWER}')`);
  }

  /** Espera a que el listado muestre el botón de filtros (página cargada). */
  async waitForToggle(timeout?: number): Promise<void> {
    await waitUntil(this.page, `document.querySelector('${FILTER_SEL.toggle}')`, timeout);
  }

  /**
   * Abre el drawer. Antes espera a que no quede ningún overlay (p. ej. el propio drawer aún
   * deslizándose tras cerrarse, o un toast) que tape el botón.
   */
  async open(): Promise<void> {
    if (await this.isOpen()) return;
    await this.waitForToggle();
    await clickUnobscured(this.page, FILTER_SEL.toggle, { overlays: true });
    await waitUntil(this.page, `document.querySelector('${DRAWER}')`);
    await this.page.wait(400); // transición del offcanvas
  }

  /** Cierra el drawer con la X y espera a que termine de deslizarse y se desmonte. */
  async close(): Promise<void> {
    if (!(await this.isOpen())) return;
    await this.closeTreePanels();
    await this.click(FILTER_SEL.closeButton);
    await waitForOverlaysClosed(this.page);
  }

  /** Configura la condición del filtro (campo, operador y valor). Abre el drawer si hace falta. */
  async addCondition(c: FilterCondition): Promise<void> {
    await this.open();
    await this.field.select(c.field);
    if (c.operator) {
      await waitEnabled(this.page, FILTER_SEL.operator);
      // La app propone un operador por defecto al elegir el campo, de forma asíncrona. Se le da margen
      // para no abrir el panel mientras lo aplica (pulsar la opción ya activa la deseleccionaría).
      const proposed = await waitUntil(
        this.page,
        `document.querySelector('${this.operator.labelSelector}')?.innerText.trim() === ${JSON.stringify(c.operator)}`,
        5_000,
      ).then(
        () => true,
        () => false,
      );
      if (!proposed) await this.operator.select(c.operator);
    }
    const name = c.input?.name ?? c.field;
    if (c.input?.type === 'radio') {
      await this.click(`${DRAWER} input[name="${name}"][value="${c.value}"]`);
    } else {
      const input = `${DRAWER} input[name="${name}"]:not([readonly]):not([type=radio]):not([type=hidden])`;
      await waitEnabled(this.page, input);
      await this.page.find(input).fill(c.value);
    }
  }

  /** Pulsa "Apply Filters" (cuando la condición es válida) y espera a que el drawer se cierre. */
  async apply(): Promise<void> {
    await waitEnabled(this.page, FILTER_SEL.apply);
    await this.click(FILTER_SEL.apply);
    await waitUntil(this.page, `!document.querySelector('${DRAWER}')`);
  }

  /** Pulsa "Clear" en la cabecera del drawer (abriéndolo si hace falta). */
  async clear(): Promise<void> {
    await this.open();
    await this.click(FILTER_SEL.clear);
  }

  /** Texto de los filtros activos mostrados sobre la tabla ('' si no hay). */
  async getActiveFilters(): Promise<string> {
    return this.page.evaluate<string>(`document.querySelector('${FILTER_SEL.activeFilters}')?.innerText ?? ''`);
  }

  /** Quita un filtro activo pulsando el botón de su chip (el primero por defecto). */
  async removeActiveFilter(index = 0): Promise<void> {
    const buttons = `${FILTER_SEL.activeFilters} button`;
    if (index === 0) {
      await this.click(buttons);
      return;
    }
    await waitUntil(this.page, `document.querySelectorAll('${buttons}').length > ${index}`);
    await this.page.evaluate(`document.querySelectorAll('${buttons}')[${index}].click()`);
  }

  /** Cierra el panel de un TreeSelect del drawer que haya quedado abierto. */
  private async closeTreePanels(): Promise<void> {
    if ((await this.isOpen()) && (await this.field.isOpen())) await this.field.close();
  }

  /** Clic estable: sin paneles de TreeSelect, toasts ni overlays encima, y centrado en el viewport. */
  private async click(selector: string): Promise<void> {
    await this.closeTreePanels();
    await clickUnobscured(this.page, selector);
  }
}
