# QA Automation Suite - DatAscend (`mi-suite-qa`)

Suite de pruebas automatizadas **API + End-to-End (E2E)** para la plataforma **DatAscend** (`qa2.datascend.net`), desarrollada en **TypeScript**, **Vitest** y **Vibium (WebDriver BiDi)** bajo arquitectura **Page Object Model (POM)** e integrada con **GitHub Actions**.

---

## 🛠️ Tecnologías y Arquitectura

* **Lenguaje:** TypeScript
* **Test Runner & Reportes:** Vitest (con generación de reportes HTML autocontenidos)
* **Browser Automation (E2E):** Vibium (WebDriver BiDi sobre Chromium/Chrome)
* **Patrón de diseño:** Page Object Model (`tests/support/pages/`) + helpers de sesión y cliente HTTP (`tests/support/`) + capa de pruebas de contratos y seguridad REST (`tests/APIs/`)
* **CI/CD y Control de Versiones:** Git, GitHub y GitHub Actions (`.github/workflows/qa-suite.yml`)

---

## 📋 Requisitos Previos

Asegúrate de contar con lo siguiente instalado en tu entorno local:

* **Node.js** (Versión 18 o superior)
* **npm** (Incluido con Node.js)
* **Git**
* **Google Chrome o Chromium** instalado

---

## 🚀 Instalación y Configuración Inicial

### 1. Clonar el Repositorio
```bash
git clone [https://github.com/FabianD433/mi-suite-qa.git](https://github.com/FabianD433/mi-suite-qa.git)
cd mi-suite-qa
```

### 2. Instalar Dependencias
```bash
npm install
```

### 3. Configurar Variables de Entorno (`.env`)
Crea un archivo `.env` en la raíz del proyecto (al mismo nivel que `package.json`, excluido de Git) y agrega las credenciales de acceso a QA2:

```env
DATASCEND_URL=[https://qa2.datascend.net](https://qa2.datascend.net)
DATASCEND_EMAIL=tu_usuario@dominio.com
DATASCEND_PASSWORD=tu_contraseña
# NOTIFICATIONS_DESTRUCTIVE=false # Cambiar a true solo para pruebas destructivas reales
```

> **Nota de seguridad:** Nunca subas el archivo `.env` ni credenciales reales al repositorio. En CI/CD se gestionan mediante **GitHub Repository Secrets** (`DATASCEND_EMAIL` y `DATASCEND_PASSWORD`).

---

## 🧪 Ejecución de Pruebas

### 🔌 Suite de APIs (Contratos, Seguridad y Manejo de Errores)
Ejecuta las pruebas críticas de backend sin abrir navegador (~30–40 segundos):
```bash
npm run test:api
```
*(O directamente con `npx vitest run tests/APIs`)*

### 🟢 Suite E2E Completa (En Serie)
Ejecuta todos los módulos E2E (`login`, `dashboard`, `settings`, `users`, `notifications`) de forma secuencial para evitar colisiones de sesión en QA2:
```bash
npx vitest run --exclude "tests/APIs/**" --no-file-parallelism
```

> ⚠️ **Advertencia operativa:** Evita ejecutar la suite E2E en local mientras haya un workflow activo corriendo en GitHub Actions, ya que ambos comparten la misma cuenta administrativa en `qa2.datascend.net` y pueden pisar preferencias de idioma, tema o datos de prueba en curso.

### 🔍 Ejecutar un Módulo E2E Específico
Si deseas validar únicamente una sección del sistema:

* **Módulo de Usuarios:**
  ```bash
  npx vitest run tests/users/users.spec.ts
  ```
* **Módulo de Settings:**
  ```bash
  npx vitest run tests/settings/settings.spec.ts
  ```
* **Módulo de Notifications:**
  ```bash
  npx vitest run tests/notifications/notifications.spec.ts
  ```
* **Módulo de Dashboard:**
  ```bash
  npx vitest run tests/dashboard/dashboard.spec.ts
  ```
* **Módulo de Login / Auth:**
  ```bash
  npx vitest run tests/login.spec.ts
  ```

### 🖥️ Modo Interfaz Gráfica (Vitest UI)
Abre un dashboard interactivo en el navegador para ver tiempos de ejecución, logs y correr pruebas bajo demanda:
```bash
npx vitest --ui
```
*Nota: Si solicita autenticación en el navegador, copia la URL completa con el token que se despliega en la consola (ej. `http://localhost:51204/__vitest__/?token=...`).*

---

## 📂 Estructura del Proyecto

```text
mi-suite-qa/
├── .github/
│   └── workflows/
│       └── qa-suite.yml              # Pipeline CI/CD (push a main + ejecución nocturna)
├── tests/
│   ├── APIs/                         # Pruebas REST de contratos, auth y seguridad
│   │   ├── critical-endpoints.api.spec.ts
│   │   └── BACKEND_BUGS_REPORT.md    # Reporte técnico de defectos detectados en QA2
│   ├── dashboard/
│   │   └── dashboard.spec.ts         # Widgets, navegación principal y logout
│   ├── notifications/
│   │   └── notifications.spec.ts     # Drawer de notificaciones, lectura y eliminación
│   ├── settings/
│   │   └── settings.spec.ts          # Preferencias de perfil, i18n, dark mode y timezone
│   ├── users/
│   │   └── users.spec.ts             # CRUD completo de usuarios, filtros, paginación y roles
│   ├── login.spec.ts                 # Flujos de autenticación e inicio de sesión
│   └── support/
│       ├── datascend.ts              # Configuración base, lanzamiento Vibium, esperas y anti-overlay
│       ├── session.ts                # Cliente HTTP api(), loggedInPage y helpers de navegación
│       └── pages/                    # Capa Page Object Model (POM)
│           ├── AppShell.ts           # Cabecera global, menú de usuario, idioma, tema y toasts
│           ├── ConfirmModal.ts       # Modales de confirmación (.modal.show)
│           ├── FilterDrawer.ts       # Panel lateral de filtros dinámicos
│           ├── LoginPage.ts          # Formulario y acciones de autenticación
│           ├── NotificationsDrawer.ts# Campana y panel lateral de notificaciones
│           ├── TreeSelect.ts         # Selectores jerárquicos (.p-treeselect-panel)
│           ├── UserFormPage.ts       # Formulario de creación/edición de usuarios, roles y dominios
│           └── UsersListPage.ts      # Tabla de usuarios, menú contextual (⋮) y paginación
├── .env                              # Variables de entorno locales (ignorado por Git)
├── package.json                      # Dependencias y scripts del proyecto
└── vitest.config.ts                  # Configuración principal de Vitest y reportes HTML
```

---

## ⚙️ CI/CD en GitHub Actions

El workflow `.github/workflows/qa-suite.yml` automatiza la ejecución completa en la nube sobre `ubuntu-latest`:

* **Disparadores:** Automático en cada `push` a `main`, ejecución programada diaria (2:00 AM hora Costa Rica) y ejecución manual (`workflow_dispatch`).
* **Entorno Headless Linux:** Configura automáticamente `VIBIUM_CHROME_ARGS` (`--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --window-size=1440,900`) y las dependencias de sistema de Chromium.
* **Evidencia y Reportes:** Al finalizar cada corrida (pase o falle), sube como artifact (`qa-reports`) los reportes HTML autocontenidos de API y E2E junto con capturas de pantalla automáticas ante cualquier fallo, retenidos por 14 días.

---

## 🌐 Flujo de Trabajo Git

1. **Revisar estado de cambios:**
   ```bash
   git status
   ```
2. **Preparar los archivos modificados:**
   ```bash
   git add .
   ```
3. **Crear el commit siguiendo Conventional Commits:**
   ```bash
   git commit -m "feat(e2e): agregar nuevas pruebas automatizadas del módulo X"
   ```
4. **Enviar los cambios a GitHub (dispara el pipeline CI automáticamente):**
   ```bash
   git push origin main
   ```