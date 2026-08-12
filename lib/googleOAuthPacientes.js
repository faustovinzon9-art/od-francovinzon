// OAuth como el odontólogo (odontologofrancovinzon@gmail.com), solo para el módulo de
// Pacientes. Existe porque la cuenta de servicio (usada para Calendar en
// lib/googleCalendar.js) no tiene cuota de almacenamiento propia en Drive — no puede
// CREAR archivos nuevos en un Drive personal sin Google Workspace (confirmado
// empíricamente: "The user's Drive storage quota has been exceeded" al copiar la
// plantilla). La cuenta de servicio sigue sirviendo para Calendar sin cambios.
//
// Scopes pedidos (ver decisions.md): drive (completo) + spreadsheets. Se probó primero
// con drive.file (no sensible) + selector de carpeta (Google Picker) para acotar el
// acceso a la carpeta "Pacientes" — confirmado empíricamente (2026-08-11, logs de Vercel:
// GaxiosError: File not found al copiar la plantilla) que elegir una carpeta por Picker
// con drive.file NO da acceso a los archivos que ya existían adentro (ni a los pacientes
// ya cargados, ni a la plantilla "FICHA NO MODIFICAR" que usa "Crear ficha") — Picker con
// drive.file solo cubre archivos nuevos que la app crea. Sin eso, ni "listar" ni "crear"
// podían funcionar. "drive" es scope sensible (no restringido) — no pide verificación de
// Google mientras el uso quede bajo ~100 usuarios (confirmado en la consola de Google
// Cloud). Ya no hace falta el paso del selector de carpeta (Picker) — un solo "Conectar
// con Google" alcanza.
import { google } from 'googleapis';
import { envolverConReintentos } from './retry.js';

const REDIRECT_URI = 'https://od-francovinzon.vercel.app/api/gestion/pacientes';
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    REDIRECT_URI
  );
}

// Arma la URL de consentimiento de Google. "state" viaja y vuelve en el callback para
// confirmar que la respuesta corresponde a un pedido nuestro (se valida contra
// GESTION_KEY, ver api/gestion/pacientes.js).
export function buildAuthUrl(state) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // fuerza que Google mande refresh_token aunque ya se haya autorizado antes
    scope: SCOPES,
    state,
  });
}

// Intercambia el "code" del callback por tokens. Devuelve el refresh_token (se guarda
// una sola vez, a mano, en GOOGLE_OAUTH_REFRESH_TOKEN de Vercel — no hay forma de que la
// función serverless se lo escriba sola).
export async function exchangeCodeForTokens(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Cliente autenticado con el refresh_token ya guardado — el uso normal, día a día, de
// todo el módulo de Pacientes. googleapis renueva el access_token solo.
function getAuthorizedClient() {
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  return client;
}

// Envueltos con reintento automático (lib/retry.js) — ver el comentario equivalente en
// lib/googleCalendar.js.
export function getPacientesSheetsClient() {
  return envolverConReintentos(google.sheets({ version: 'v4', auth: getAuthorizedClient() }));
}

export function getPacientesDriveClient() {
  return envolverConReintentos(google.drive({ version: 'v3', auth: getAuthorizedClient() }));
}
