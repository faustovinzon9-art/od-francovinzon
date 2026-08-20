// Extrae la URL real codificada en el QR de "Firma Electrónica" de una receta
// MisRX/RCTA (ver el pedido, 2026-08-20: "necesito que sea el mismo [QR]... y me
// conduzca a lo mismo que el original"). Ese QR codifica un token único por receta
// (confirmado escaneando una receta real: "https://misrx.com.ar/receta?token=...") —
// no es algo derivable del CUIR ni de ningún otro campo de texto, así que la única
// forma de que la receta linda escanee al mismo lugar es leer el QR real de adentro
// del PDF y volver a dibujarlo con el mismo contenido (no hace falta copiar el
// gráfico pixel a pixel: un QR nuevo con el mismo texto decodifica exactamente igual).
//
// Los códigos de barra (Recetario/CUIR y Nro Afiliado), en cambio, NO llevan un token
// oculto — son una codificación estándar de un valor que el OCR de texto ya lee
// perfecto (ver lib/recetaParser.js), así que esos se generan directo a partir de ese
// texto en lib/pdfExport.js, sin pasar por acá.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import jsQR from 'jsqr';

export async function extraerUrlFirmaElectronica(pdfBuffer) {
  try {
    const data = new Uint8Array(pdfBuffer);
    const doc = await getDocument({ data, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 3 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const qr = jsQR(imageData.data, imageData.width, imageData.height);
    return qr ? qr.data : null;
  } catch (err) {
    console.error('extraerUrlFirmaElectronica falló (se sigue sin QR):', err);
    return null;
  }
}
