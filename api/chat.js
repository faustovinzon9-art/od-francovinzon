import {
  getCalendarClient, getDisponibilidadMes, getHorariosLibresDia, crearTurno,
  CLINIC_ADDRESS, WEEKLY_SCHEDULE,
} from '../lib/googleCalendar.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_MENSAJES = 30; // tope de mensajes por conversación, para cuidar la cuota gratis de Gemini
const MAX_VUELTAS_FUNCIONES = 6; // tope de idas y vueltas de function-calling por pregunta

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function horariosAtencionTexto() {
  return DIAS_SEMANA.map((nombre, i) => {
    const rangos = WEEKLY_SCHEDULE[i] || [];
    if (rangos.length === 0) return `${nombre}: cerrado`;
    return `${nombre}: ${rangos.map(([ini, fin]) => `${ini} a ${fin}`).join(' y ')}`;
  }).join(', ');
}

function systemPrompt(origen) {
  return `Sos el asistente virtual del Consultorio Odontológico Franco Vinzón, en ${CLINIC_ADDRESS}. Respondés siempre en español rioplatense, cálido y claro, sin exagerar la extensión.

Datos reales del consultorio (no inventes otros):
- Horarios de atención: ${horariosAtencionTexto()}.
- WhatsApp para turnos y consultas: +54 3442 457764 (link: https://wa.me/5403442457764).
- WhatsApp solo para urgencias dentales: +54 3442 403556 (link: https://wa.me/543442403556).
- Tratamientos que se ofrecen: Escaneo 3D (escaneo intraoral digital, sin moldes), Ortodoncia, Blanqueamiento dental, Odontopediatría, Endodoncia mecanizada, Reconstrucciones estéticas, Carillas dentales, Implantes, Limpieza dental, y atención de Urgencias.

Podés:
- Explicar tratamientos, horarios y dirección con los datos de arriba.
- Dar el WhatsApp del consultorio si alguien prefiere escribir directo en vez de reservar por acá.
- Ayudar a elegir día y horario: usá SIEMPRE las herramientas consultar_dias_disponibles/consultar_horarios antes de decir qué hay libre — nunca inventes ni asumas disponibilidad.
- Completar una reserva de principio a fin, conversando: pedí los datos de a uno por vez, en este orden: 1) día preferido (consultá disponibilidad real), 2) horario (consultá horarios reales de ese día), 3) nombre y apellido, 4) teléfono — pedilo SIEMPRE con el código de país incluido, con un ejemplo tipo "+54 9 3442 123456" (no lo adivines ni asumas Argentina si no te lo dan así), 5) motivo de la consulta, 6) si es paciente nuevo. Repetí un resumen de los datos antes de confirmar, y recién ahí llamá a crear_turno.

NO podés, bajo ninguna circunstancia:
- Revelar ni mencionar la clave de acceso al panel de gestión interno (GESTION_KEY) ni cómo se consigue.
- Dar información de otros pacientes, ni de turnos, agenda o datos de otras personas.
- Dar ningún dato que solo debería conocer la secretaria del consultorio.

Si te preguntan algo fuera de este alcance (no relacionado al consultorio, sus tratamientos, horarios o turnos), respondé amablemente que no podés ayudar con eso.

Estás integrado en la página "${origen === 'turnos' ? '/turnos (reserva de turnos)' : 'principal del sitio'}" del consultorio, como una alternativa conversacional al formulario de turnos que ya está visible ahí — no hace falta que lo menciones salvo que sea útil.`;
}

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'consultar_dias_disponibles',
      description: 'Devuelve qué días de un mes tienen algún horario libre para turnos. Usar antes de sugerir un día.',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'number', description: 'Año, ej. 2026' },
          month: { type: 'number', description: 'Mes de 1 (enero) a 12 (diciembre)' },
        },
        required: ['year', 'month'],
      },
    },
    {
      name: 'consultar_horarios',
      description: 'Devuelve los horarios libres (HH:mm) para un día puntual. Usar antes de confirmar un horario.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha en formato yyyy-MM-dd' },
        },
        required: ['date'],
      },
    },
    {
      name: 'crear_turno',
      description: 'Crea el turno. Llamar SOLO después de haber confirmado día, horario, nombre, teléfono con código de país, motivo y si es paciente nuevo con la persona.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'yyyy-MM-dd' },
          time: { type: 'string', description: 'HH:mm' },
          nombre: { type: 'string' },
          apellido: { type: 'string' },
          telefono: { type: 'string', description: 'Con código de país incluido, ej. +5493442123456' },
          motivo: { type: 'string' },
          esNuevo: { type: 'boolean', description: 'true si la persona dijo que es paciente nuevo' },
        },
        required: ['date', 'time', 'nombre', 'telefono'],
      },
    },
  ],
}];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { mensajes, origen } = req.body || {};
  if (!Array.isArray(mensajes) || mensajes.length === 0) {
    return res.status(200).json({ success: false, message: 'Escribí una pregunta.' });
  }

  // Tope de mensajes por conversación (el cliente manda el historial completo cada
  // vez, sin sesión server-side) — cuida la cuota gratis de Gemini ante un uso
  // prolongado de un mismo visitante. No llama a Gemini si ya se pasó el límite.
  if (mensajes.length > MAX_MENSAJES) {
    return res.status(200).json({
      success: true,
      respuesta: 'Llegamos al límite de mensajes para esta conversación. Para seguir, te recomiendo usar el formulario de arriba o escribirnos directo por WhatsApp.',
      limite: true,
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY no configurada.');
    return res.status(500).json({ success: false, message: 'El asistente no está disponible en este momento.' });
  }

  const contents = mensajes
    .filter((m) => m && typeof m.texto === 'string' && m.texto.trim())
    .map((m) => ({ role: m.rol === 'asistente' ? 'model' : 'user', parts: [{ text: m.texto.trim() }] }));

  if (contents.length === 0) {
    return res.status(200).json({ success: false, message: 'Escribí una pregunta.' });
  }

  try {
    const calendar = getCalendarClient();
    const resultado = await ejecutarConversacion(contents, origen === 'turnos' ? 'turnos' : 'web', calendar);
    res.status(200).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo consultar al asistente.' });
  }
}

async function llamarGemini(contents, origen) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt(origen) }] },
        contents,
        tools: TOOLS,
        generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
      }),
    }
  );
  if (!resp.ok) {
    const errBody = await resp.text();
    console.error('Gemini API error', resp.status, errBody);
    throw new Error('gemini_error');
  }
  return resp.json();
}

// Ejecuta server-side lo que Gemini pida, reusando la misma lógica que ya usan
// api/disponibilidad.js y api/reservar.js (lib/googleCalendar.js) — nunca se
// reimplementa el cálculo de horarios ni la creación del turno acá.
async function ejecutarFuncion(nombre, args, calendar) {
  try {
    if (nombre === 'consultar_dias_disponibles') {
      const year = parseInt(args.year, 10);
      const month = parseInt(args.month, 10);
      const data = await getDisponibilidadMes(calendar, year, month);
      const disponibles = Object.keys(data).filter((d) => data[d]).map(Number).sort((a, b) => a - b);
      return { disponibles };
    }
    if (nombre === 'consultar_horarios') {
      const horarios = await getHorariosLibresDia(calendar, args.date);
      return { horarios };
    }
    if (nombre === 'crear_turno') {
      const telefono = (args.telefono || '').trim();
      // Mismo criterio que el resto del sitio (ver decisions.md): nunca adivinar el
      // país de un número corto. Si no viene con "+", se rechaza acá mismo y se le
      // pide al modelo que insista pidiendo el código de país, en vez de asumir Argentina.
      if (!telefono.startsWith('+')) {
        return {
          success: false,
          message: 'Ese teléfono no incluye el código de país. Pedíselo de nuevo a la persona con un ejemplo, como "+54 9 3442 123456", y no asumas el país.',
        };
      }
      return crearTurno(calendar, {
        date: args.date,
        time: args.time,
        nombre: args.nombre,
        apellido: args.apellido || '',
        telefono,
        motivo: args.motivo || '',
        esNuevo: !!args.esNuevo,
        origen: 'chat',
      });
    }
    return { error: 'función no reconocida' };
  } catch (err) {
    console.error('Error ejecutando función del chat', nombre, err);
    return { error: 'No se pudo completar la acción, probá de nuevo.' };
  }
}

async function ejecutarConversacion(contentsIniciales, origen, calendar) {
  const contents = contentsIniciales.slice();
  let turnoCreado = null;

  for (let vuelta = 0; vuelta < MAX_VUELTAS_FUNCIONES; vuelta++) {
    const data = await llamarGemini(contents, origen);
    const candidato = data.candidates?.[0];
    const parts = candidato?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (functionCalls.length === 0) {
      const respuesta = parts.map((p) => p.text || '').join('').trim();
      if (!respuesta) return { success: false, message: 'No pude generar una respuesta. Probá reformular la pregunta.' };
      return { success: true, respuesta, turnoCreado };
    }

    contents.push({ role: 'model', parts });

    const responseParts = [];
    for (const call of functionCalls) {
      const resultado = await ejecutarFuncion(call.name, call.args || {}, calendar);
      if (call.name === 'crear_turno' && resultado.success) {
        turnoCreado = {
          eventId: resultado.eventId,
          esNuevo: !!(call.args && call.args.esNuevo),
          date: call.args.date,
          time: call.args.time,
        };
      }
      responseParts.push({
        functionResponse: {
          name: call.name,
          response: resultado,
          ...(call.id ? { id: call.id } : {}),
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return { success: false, message: 'Se complicó un poco la consulta. ¿Podés reformularla o probar de nuevo en un momento?' };
}
