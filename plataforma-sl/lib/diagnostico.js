'use strict';
/*
 * Lógica de calificación del diagnóstico, ejecutada en el SERVIDOR.
 * Es una copia fiel de los criterios del HTML original (Codigo_practicaV6.html):
 *   - 14 preguntas: tipo "conocimiento" (se califica, c = índice correcto) o "perfil" (no se califica)
 *   - porcentaje = round(correctas / totalConocimiento * 100)
 *   - nota       = round(porcentaje / 100 * 5 * 10) / 10      (escala 0.0 – 5.0)
 *   - nivel      : >=90 Avanzado · >=70 Intermedio · >=50 Básico · <50 Inicial
 * El navegador sólo envía qué opción marcó el estudiante; nunca la nota.
 *
 * IMPORTANTE: si cambias las preguntas en public/index.html (const DIAGNOSTICO),
 * actualiza también este archivo. `npm test` verifica que ambos coincidan.
 */

// q se conserva para guardar el "perfil declarado" tal como lo hacía la versión original.
const PREGUNTAS = [
  { tipo: 'conocimiento', c: 1, o: ['Parte física del computador.', 'Conjunto de programas y aplicaciones.', 'Dispositivo electrónico.'], q: '¿Qué es el Software?' },
  { tipo: 'perfil', o: ['Licenciado.', 'Libre.', 'No sabe.'], q: '¿Qué tipo de software utiliza con mayor frecuencia?' },
  { tipo: 'conocimiento', c: 1, o: ['Software gratis.', 'Software que se puede modificar y distribuir.', 'Software ilegal.'], q: '¿Qué es software libre?' },
  { tipo: 'perfil', o: ['Sí.', 'No.', 'No sabe.'], q: '¿Ha utilizado software sin licencia?' },
  { tipo: 'perfil', o: ['Costo.', 'Facilidad para uso.', 'No lo considera necesario.'], q: '¿Por qué usaría software sin licencia?' },
  { tipo: 'perfil', o: ['Windows.', 'Linux.', 'No sabe.'], q: '¿Qué sistema operativo usa?' },
  { tipo: 'perfil', o: ['Sí.', 'No.', 'Parcialmente.'], q: '¿Conoce los riesgos del software pirata?' },
  { tipo: 'conocimiento', c: 1, o: ['Descargar una versión pirata.', 'Buscar alternativas gratuitas/libres.', 'Asumir otra responsabilidad.'], q: 'Situación: se necesita Word pero no se puede pagar, ¿qué se debe hacer?' },
  { tipo: 'conocimiento', c: 1, o: ['Dos libertades.', 'Cuatro libertades (0, 1, 2 y 3).', 'Siete libertades.'], q: '¿Cuántas libertades definen al software libre?' },
  { tipo: 'conocimiento', c: 0, o: ['Para establecer las condiciones de uso, copia y distribución.', 'Para acelerar el computador.', 'Para eliminar virus.'], q: '¿Para qué sirve una licencia de software?' },
  { tipo: 'conocimiento', c: 1, o: ['Adobe Reader.', 'LibreOffice.', 'WinRAR.'], q: '¿Cuál de estas es una alternativa libre a Microsoft Office?' },
  { tipo: 'conocimiento', c: 1, o: ['Que el software pasa a ser de dominio público.', 'Que las obras derivadas deben mantener las mismas libertades.', 'Que prohíbe cualquier modificación.'], q: '¿Qué significa que una licencia sea "copyleft" (como la GNU GPL)?' },
  { tipo: 'conocimiento', c: 1, o: ['Sí, siempre son sinónimos.', 'No: lo libre se refiere a las libertades, no al precio.', 'Sí, pero sólo en Linux.'], q: '¿Software libre es lo mismo que software gratuito?' },
  { tipo: 'conocimiento', c: 0, o: ['Infecciones de malware y falta de actualizaciones de seguridad.', 'Que el equipo funcione más rápido.', 'Que se amplíe la garantía del equipo.'], q: '¿Cuál es un riesgo real de usar software pirata?' }
];

const TOTAL_CONOCIMIENTO = PREGUNTAS.filter(p => p.tipo === 'conocimiento').length;

const MODULOS = ['mod0', 'mod1', 'mod2', 'mod3', 'mod4', 'mod5', 'mod6', 'mod7', 'mod8'];

const RETROALIMENTACION = {
  'Inicial': 'Estás comenzando tu aprendizaje sobre Software Libre. Te recomendamos revisar cuidadosamente los conceptos básicos, las licencias y las cuatro libertades antes de avanzar.',
  'Básico': 'Posees conocimientos iniciales sobre Software Libre. Te recomendamos reforzar conceptos relacionados con licencias, código fuente y diferencias entre software libre y software gratuito.',
  'Intermedio': 'Demuestras un conocimiento intermedio. Puedes profundizar en las licencias, modelos de distribución, filosofía del Software Libre y aplicaciones prácticas.',
  'Avanzado': 'Demuestras un conocimiento avanzado sobre Software Libre. Puedes profundizar en aspectos técnicos, licenciamiento, comunidades de desarrollo y aplicación profesional.'
};

function nivelPorPorcentaje(p) {
  if (p >= 90) return 'Avanzado';
  if (p >= 70) return 'Intermedio';
  if (p >= 50) return 'Básico';
  return 'Inicial';
}

function recomendacionPorPorcentaje(p) {
  return p >= 90 ? 'Excelente base. Puedes avanzar directamente a los módulos de licencias, comunidades y proyecto final.'
    : p >= 70 ? 'Buena base. Refuerza el módulo 2 (Licencias) para afianzar los conceptos jurídicos.'
    : p >= 50 ? 'Base parcial. Revisa con detenimiento los módulos 1 (Fundamentos) y 2 (Licencias).'
    : 'Se recomienda iniciar desde el módulo 1 (Fundamentos) y avanzar de forma secuencial.';
}

/**
 * Valida y califica. `respuestas` es un objeto { "0": 1, "1": 2, ... }.
 * Devuelve { error } si la entrada es inválida, o el resultado calculado.
 * Igual que el original, no se permite finalizar con preguntas sin responder.
 */
function calificar(respuestas) {
  if (!respuestas || typeof respuestas !== 'object' || Array.isArray(respuestas)) {
    return { error: 'Formato de respuestas inválido.' };
  }
  const faltantes = [];
  const lista = [];
  PREGUNTAS.forEach((p, i) => {
    const v = respuestas[i];
    if (!Number.isInteger(v) || v < 0 || v >= p.o.length) { faltantes.push(i + 1); lista.push(null); }
    else lista.push(v);
  });
  if (faltantes.length) {
    return { error: `Faltan preguntas por responder o tienen una opción inválida: ${faltantes.join(', ')}.`, faltantes };
  }

  let correctas = 0, incorrectas = 0, sinResponder = 0;
  const filas = [];
  const perfil = [];
  PREGUNTAS.forEach((p, i) => {
    const v = lista[i];
    if (p.tipo === 'perfil') {
      perfil.push({ q: p.q, r: v !== null ? p.o[v] : null });
      filas.push({ idx: i, tipo: 'perfil', opcion: v, correcta: null });
      return;
    }
    if (v === null) { sinResponder++; filas.push({ idx: i, tipo: 'conocimiento', opcion: null, correcta: null }); }
    else if (v === p.c) { correctas++; filas.push({ idx: i, tipo: 'conocimiento', opcion: v, correcta: true }); }
    else { incorrectas++; filas.push({ idx: i, tipo: 'conocimiento', opcion: v, correcta: false }); }
  });

  const porcentaje = TOTAL_CONOCIMIENTO ? Math.round((correctas / TOTAL_CONOCIMIENTO) * 100) : 0;
  const nota = Math.round((porcentaje / 100) * 5 * 10) / 10;
  const nivel = nivelPorPorcentaje(porcentaje);
  return {
    correctas, incorrectas, sinResponder, porcentaje, nota, nivel,
    totalConocimiento: TOTAL_CONOCIMIENTO,
    retroalimentacion: RETROALIMENTACION[nivel],
    recomendacion: recomendacionPorPorcentaje(porcentaje),
    perfil, filas
  };
}

module.exports = { PREGUNTAS, TOTAL_CONOCIMIENTO, MODULOS, RETROALIMENTACION, nivelPorPorcentaje, calificar };
