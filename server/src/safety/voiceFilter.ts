/*
 * Thin TypeScript wrapper over extension/shared/voice-filter.js.
 *
 * The streaming filter lives in the shared file so a future in-extension BYOK
 * path filters replies exactly the same way the server does. This file only
 * restates the type.
 *
 * guards-core.js is imported first and explicitly: voice-filter.js looks up
 * globalThis.SmGuards at call time, so the dependency is load-order sensitive
 * and a bare re-export of this module alone would not pull it in.
 */
import '../../../extension/shared/guards-core.js';
import '../../../extension/shared/voice-filter.js';

export interface VoiceFilter {
  push(chunk: string): string;
  flush(): string;
}

interface VoiceFilterApi {
  createMaomaoStreamFilter(): VoiceFilter;
}

const api = (globalThis as unknown as { SmVoiceFilter: VoiceFilterApi }).SmVoiceFilter;
if (!api) {
  throw new Error('extension/shared/voice-filter.js did not install globalThis.SmVoiceFilter');
}

export function createMaomaoStreamFilter(): VoiceFilter {
  return api.createMaomaoStreamFilter();
}
