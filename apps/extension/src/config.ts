// Build-time configuration (see vite.config.ts for how release builds validate these).
export const API_BASE_URL: string = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const PRIVACY_POLICY_URL: string =
  import.meta.env.VITE_PRIVACY_POLICY_URL || 'https://github.com/assemkdv/gitguide/blob/main/docs/PRIVACY.md';
