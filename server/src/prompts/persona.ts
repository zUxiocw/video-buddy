/*
 * Thin TypeScript wrapper over extension/shared/persona.js.
 *
 * The persona rules live in one place so the server and the extension cannot
 * drift apart. This file only adds the types and re-exports; there is no
 * second copy of the rules. See extension/shared/persona.js for why that file
 * is a classic script rather than an ES module.
 */
import '../../../extension/shared/persona.js';
import type { Tone } from '../types.js';

export interface Persona {
  id: Tone;
  label: string;
  rules: string;
}

interface PersonaApi {
  PERSONAS: Record<Tone, Persona>;
  personaFor(tone: Tone): Persona;
}

const api = (globalThis as unknown as { SmPersona: PersonaApi }).SmPersona;
if (!api) {
  throw new Error('extension/shared/persona.js did not install globalThis.SmPersona');
}

export const PERSONAS: Record<Tone, Persona> = api.PERSONAS;

export function personaFor(tone: Tone): Persona {
  return api.personaFor(tone);
}
