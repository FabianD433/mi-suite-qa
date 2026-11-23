import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Pruebas E2E contra qa2: comparten la misma cuenta, así que van en serie.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Consola + reporte HTML de @vitest/ui. `singleFile`: un único <dir>/index.html autocontenido
    // (se abre directamente en el navegador, también al descargarlo como artifact de CI).
    // VITEST_HTML_DIR permite separar reportes por ejecución (CI: reports/api y reports/e2e).
    // Las capturas de tests E2E fallidos van a reports/screenshots/ (ver tests/support/datascend.ts).
    reporters: ['default', ['html', { outputDir: process.env.VITEST_HTML_DIR || 'reports', singleFile: true }]],
  },
});
