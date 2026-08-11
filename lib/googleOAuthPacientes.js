// OAuth como el odontólogo (odontologofrancovinzon@gmail.com), solo para el módulo de
// Pacientes. Existe porque la cuenta de servicio (usada para Calendar en
// lib/googleCalendar.js) no tiene cuota de almacenamiento propia en Drive — no puede
// CREAR archivos nuevos en un Drive personal sin Google Workspace (confirmado
// empíricamente: "The user's Drive storage quota has been exceeded" al copiar la
// plantilla). La cuenta de servicio sigue sirviendo para Calendar sin cambios.
//
// Scopes pedidos (ver decisions.md): drive.file (no sensible) + spreadsheets (sensible,
// no restringido) — evita a propósito el scope completo "drive" (restringido, pediría
// verificación pesada de Google). drive.file solo ve archivos que la app crea, salvo que
// el usuario haya elegido una carpeta con el selector de Google (Picker) — por eso el
// setup único en gestion/conectar-drive.html hace elegir la carpeta "Pacientes" una vez,
// lo que extiende el acceso de drive.file a todo su contenido (existente y futuro).
import { google } from 'googleapis';

const REDIRECT_URI = 'https://od-francovinzon.vercel.app/api/gestion/pacientes';
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
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

export function getPacientesSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthorizedClient() });
}

export function getPacientesDriveClient() {
  return google.drive({ version: 'v3', auth: getAuthorizedClient() });
}
