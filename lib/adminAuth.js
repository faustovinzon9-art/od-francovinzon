// Auth del panel /admin — clave propia (ADMIN_KEY), separada de GESTION_KEY. Solo
// Fausto la tiene; Ayelen no ve /admin. Mismo patrón simple que isValidGestionKey()
// de lib/googleCalendar.js, en archivo propio para no tocar ese módulo compartido por
// /turnos, /gestion y /pacientes (ver CLAUDE.md, "Regla permanente").
export function isValidAdminKey(key) {
  return !!process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
}
