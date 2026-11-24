/**
 * Page Object del componente TreeSelect de PrimeReact (`.p-treeselect`).
 *
 * Unifica la lógica que antes estaba duplicada en `selectTreeOption` (tests/support/datascend.ts) y
 * `pickTreeOption` (tests/users/users.spec.ts). Garantiza que, tras elegir una opción, el panel
 * desplegable quede cerrado: si el panel sigue abierto se superpone a otros controles (p. ej. el
 * botón "Apply Filters" del drawer de filtros) y Vibium falla con
 * `receivesEvents check failed — element is obscured`.
 */
import { evalJson, waitEnabled, waitUntil, type Page } from '../datascend';

export interface TreeSelectOptions {
  /**
   * Elemento "neutro" (sin acción propia) sobre el que hacer clic para cerrar el panel cuando no se
   * cierra solo, p. ej. el título de un drawer. Un clic fuera cierra el overlay de PrimeReact sin
   * cerrar el drawer/modal contenedor. Si no se indica, se usa la tecla Escape.
   */
  dismissTarget?: string;
}

export class TreeSelect {
  /** Panel desplegable (se monta en `body`, fuera del componente). */
  static readonly PANEL = '.p-treeselect-panel';
  /** Opciones del panel. */
  static readonly ITEM = `${TreeSelect.PANEL} li[role=treeitem]`;

  /** Selector de la opción con ese `aria-label` (PrimeReact lo rellena con el texto de la opción). */
  static option(label: string): string {
    return `${TreeSelect.PANEL} li[aria-label="${label}"]`;
  }

  /**
   * @param root Selector del contenedor `.p-treeselect` (o de un elemento que lo contenga).
   */
  constructor(
    private readonly page: Page,
    readonly root: string,
    private readonly options: TreeSelectOptions = {},
  ) {}

  get trigger(): string {
    return `${this.root} .p-treeselect-trigger`;
  }

  get labelSelector(): string {
    return `${this.root} .p-treeselect-label`;
  }

  /** ¿Hay algún panel de TreeSelect abierto? (solo puede haber uno a la vez). */
  async isOpen(): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${TreeSelect.PANEL}')`);
  }

  /** Texto mostrado en el control (opción seleccionada o placeholder). */
  async label(): Promise<string> {
    return this.page.evaluate<string>(`document.querySelector('${this.labelSelector}')?.innerText.trim() ?? ''`);
  }

  /** Espera a que el control esté habilitado y abre su panel (no hace nada si ya está abierto). */
  async open(): Promise<void> {
    await waitEnabled(this.page, this.root);
    if (!(await this.isOpen())) await this.page.find(this.trigger).click();
    await waitUntil(this.page, `document.querySelector('${TreeSelect.ITEM}')`);
  }

  /** Abre el panel y devuelve las opciones visibles (sus `aria-label`). */
  async getOptions(): Promise<string[]> {
    await this.open();
    return evalJson<string[]>(this.page, `[...document.querySelectorAll('${TreeSelect.ITEM}')].map(li => li.getAttribute('aria-label'))`);
  }

  /**
   * Elige la opción `label` (por `aria-label` o, en su defecto, por texto exacto), espera a que el
   * control la muestre y cierra el panel. Si ya está seleccionada no hace clic: PrimeReact
   * deselecciona al pulsar la opción activa.
   */
  async select(label: string): Promise<void> {
    if ((await this.label()) === label) {
      await this.close();
      return;
    }
    const byAria = `${TreeSelect.option(label)} .p-treenode-content`;
    const byText = {
      xpath: `//div[contains(@class,'p-treeselect-panel')]//*[contains(@class,'p-treenode-content')][normalize-space(.)='${label}']`,
    };
    const textMatch = `[...document.querySelectorAll('${TreeSelect.PANEL} .p-treenode-content')].some(e => e.innerText.trim() === ${JSON.stringify(label)})`;
    // Panel visible (montado y con caja no vacía), con opciones renderizadas y la opción objetivo presente.
    const panelReady = `(() => {
      const p = document.querySelector('${TreeSelect.PANEL}');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      const s = getComputedStyle(p);
      if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.opacity === '0') return false;
      if (!document.querySelector('${TreeSelect.ITEM}')) return false;
      return !!document.querySelector('${byAria}') || ${textMatch};
    })()`;
    const selected = `document.querySelector('${this.labelSelector}')?.innerText.includes(${JSON.stringify(label)})`;

    // A veces el primer clic sobre el nodo no se registra (el panel se cierra o el control no cambia):
    // se reabre el panel y se reintenta hasta 2 veces más antes de dar timeout.
    const MAX_RETRIES = 2;
    for (let attempt = 0; ; attempt++) {
      await this.open();
      await waitUntil(this.page, panelReady);
      if (await this.page.evaluate<boolean>(`!!document.querySelector('${byAria}')`)) {
        await this.page.find(byAria).click();
      } else {
        await this.page.find(byText).click();
      }
      try {
        await waitUntil(this.page, selected, 1_500);
        break;
      } catch {
        if (attempt >= MAX_RETRIES) {
          // Último intento: margen completo y error de timeout estándar si sigue sin aplicarse.
          await waitUntil(this.page, selected);
          break;
        }
      }
      // El clic pudo registrarse con retraso: no volver a pulsar (PrimeReact deselecciona la opción activa).
      if (await this.page.evaluate<boolean>(`!!(${selected})`)) break;
      // Si el panel sigue abierto, cerrarlo para que `open()` vuelva a pulsar el trigger.
      if (await this.isOpen()) await this.dismiss();
    }
    await this.close();
  }

  /** Cierra el panel de inmediato (sin esperar a que se cierre solo). */
  private async dismiss(): Promise<void> {
    if (this.options.dismissTarget) {
      await this.page.find(this.options.dismissTarget).click();
    } else {
      await this.page.keyboard.press('Escape');
    }
    await waitUntil(this.page, `!document.querySelector('${TreeSelect.PANEL}')`, 5_000);
    await this.page.wait(300); // animación de salida del overlay
  }

  /**
   * Cierra el panel si sigue abierto. Primero da margen a que se cierre solo (lo normal tras
   * seleccionar); si no, hace clic en `dismissTarget` o pulsa Escape, y espera a que se desmonte.
   */
  async close(): Promise<void> {
    if (!(await this.isOpen())) return;
    const closed = `!document.querySelector('${TreeSelect.PANEL}')`;
    try {
      await waitUntil(this.page, closed, 1_500);
      return;
    } catch {
      /* sigue abierto: cerrarlo explícitamente */
    }
    await this.dismiss();
  }
}
