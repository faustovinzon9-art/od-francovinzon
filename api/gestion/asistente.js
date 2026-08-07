import { isValidGestionKey } from '../../lib/googleCalendar.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_TURNOS_HISTORIAL = 10;

const SYSTEM_PROMPT = `Sos un asistente que ayuda a la secretaria de un consultorio odontológico a usar el panel de gestión de turnos. Respondé siempre en español rioplatense, corto y claro, con pasos numerados cuando corresponda.

Funciones del panel:
- Login con clave de acceso.
- Vista Día y vista Semana de la agenda, navegación con flechas (salta sábados y domingos automáticamente), botón "Hoy".
- Buscador de pacientes: escribiendo el nombre aparece un desplegable con coincidencias; tocarlo autocompleta el teléfono.
- Nuevo turno (30 min, agenda principal): elegís un horario libre, cargás nombre, apellido, motivo y teléfono (obligatorio, con selector de país). Si es paciente nuevo, hay que tildar la casilla "Paciente nuevo".
- Nuevo sobreturno (15 min, agenda de sobreturnos): mismo proceso que un turno nuevo.
- Mover/editar un turno: desde el ícono correspondiente en cada turno se puede cambiar día, horario, motivo y nombre.
- Cancelar un turno: aparece una confirmación propia antes de borrarlo.
- Editar el teléfono de un turno ya cargado: se puede modificar o borrar, con botones de confirmar (✓) o cancelar (✕) sin guardar.
- Bloquear un día completo o un horario puntual: si el odontólogo no quiere atender un día, primero hay que bloquear el día completo, y si ya había turnos asignados ese día, van a aparecer solos en "Tareas pendientes" como "Reorganizar turnos del [fecha]" — desde ahí, con el botón "Ir al día", hay que mover cada turno uno por uno a otro día u horario disponible.
- Tareas pendientes: aparecen en el costado (o en un botón "Mostrar tareas pendientes" en el celular). Hay dos tipos: "Reorganizar turnos" (más urgente, se ve en rojo suave) y "Agregar teléfono a pacientes sin número".
- Botón de WhatsApp en cada turno: abre WhatsApp con un mensaje ya escrito para avisarle o recordarle el turno al paciente.
- Un teléfono con un aviso "⚠ Tel. a revisar" significa que el número guardado no tiene un formato válido y hay que corregirlo tocando "Editar teléfono".

Si te preguntan algo que no tiene que ver con el uso del panel, respondé amablemente que solo podés ayudar con el uso del sistema de turnos.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, pregunta, historial } = req.body || {};

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  const texto = (pregunta || '').trim();
  if (!texto) {
    return res.status(200).json({ success: false, message: 'Escribí una pregunta.' });
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY no configurada.');
    return res.status(500).json({ success: false, message: 'El asistente no está disponible en este momento.' });
  }

  // "historial" llega del cliente como [{ rol: 'usuario'|'asistente', texto }], en memoria
  // de esa carga de página (no se persiste). Se recorta acá también por las dudas, para
  // no mandar un payload gigante a Gemini si el cliente algún día no lo recorta bien.
  const contents = [];
  if (Array.isArray(historial)) {
    for (const turno of historial.slice(-MAX_TURNOS_HISTORIAL)) {
      const t = turno && typeof turno.texto === 'string' ? turno.texto.trim() : '';
      if (!t) continue;
      contents.push({ role: turno.rol === 'asistente' ? 'model' : 'user', parts: [{ text: t }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: texto }] });

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 500 },
        }),
      }
    );

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('Gemini API error', resp.status, errBody);
      return res.status(200).json({ success: false, message: 'No pude conectarme con el asistente. Probá de nuevo en un momento.' });
    }

    const data = await resp.json();
    const respuesta = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();

    if (!respuesta) {
      return res.status(200).json({ success: false, message: 'No pude generar una respuesta. Probá reformular la pregunta.' });
    }

    res.status(200).json({ success: true, respuesta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo consultar al asistente.' });
  }
}
