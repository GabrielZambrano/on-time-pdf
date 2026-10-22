# On Time PDF

Editor de PDF personal (Windows), local y sin internet. Electron + React + PDF.js + motor Python con PyMuPDF.

## Ejecutar

```
pip install -r engine/requirements.txt
npm install
npm start          # compila y abre la app
npm run dev        # modo desarrollo
```

Opcional: `On Time PDF.exe archivo.pdf` o `electron . archivo.pdf` abre el archivo directamente.

## Funciones

- Abrir, miniaturas, navegar, zoom, buscar texto, guardar copia (nunca sobrescribe el original sin confirmar).
- Unir, dividir, extraer, eliminar, girar y reordenar páginas (arrastrando miniaturas). Deshacer / rehacer.
- Editar texto (reemplazo real: el texto original se elimina del archivo), añadir texto, imágenes y firma (imagen), resaltar, dibujar, notas, censurar.
- Formularios rellenables.
- OCR en español (requiere Tesseract instalado y en el PATH).

## Límites conocidos

- El texto de reemplazo usa fuentes estándar (Helvetica/Times/Courier) si la original no está incrustada; la app avisa.
- No se edita el contenido de páginas giradas (gírelas a 0°).
- El OCR no reconstruye el escaneo: solo lo hace buscable y seleccionable.
- Firma digital con certificado: no incluida.
- Documentos con contraseña: se rechazan con aviso.

## Licencias

PyMuPDF es AGPL-3.0, por eso este proyecto se publica bajo AGPL-3.0 (ver LICENSE).

## Instaladores y actualizaciones

- `npm run dist` empaqueta el motor Python (PyInstaller) y genera el instalador en `release/`.
- Para publicar una versión: subir `version` en `package.json`, luego `git tag vX.Y.Z && git push --tags`. GitHub Actions construye Windows y Mac y los sube al Release.
- La app instalada busca actualizaciones al abrir y con el botón «Buscar actualización».
- Mac: sin firma de Apple las actualizaciones automáticas no funcionan; se instala el `.dmg` a mano.
