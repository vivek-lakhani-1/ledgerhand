export const injectionModes = [
  "none",
  "not_found",
  "permission_denied",
  "validation",
  "slow",
  "interstitial",
  "session_expired",
  "app_error",
] as const;

export type InjectionMode = (typeof injectionModes)[number];

export interface InjectionState {
  mode: InjectionMode;
  ttlRequests: number;
}

const stickyModes = new Set<InjectionMode>([
  "not_found",
  "permission_denied",
  "validation",
]);

let state: InjectionState = { mode: "none", ttlRequests: 0 };

export function setInjection(mode: InjectionMode, ttlRequests?: number): InjectionState {
  if (mode === "none") {
    state = { mode: "none", ttlRequests: 0 };
  } else if (stickyModes.has(mode)) {
    state = { mode, ttlRequests: -1 };
  } else {
    const defaultTtl = 1;
    const ttl = Number.isInteger(ttlRequests) ? Number(ttlRequests) : defaultTtl;
    state = { mode, ttlRequests: ttl > 0 ? ttl : 0 };
    if (state.ttlRequests === 0) {
      state = { mode: "none", ttlRequests: 0 };
    }
  }
  return getInjection();
}

export function resetInjection(): void {
  state = { mode: "none", ttlRequests: 0 };
}

export function getInjection(): InjectionState {
  return { ...state };
}

export function consumeSticky(mode: InjectionMode): boolean {
  if (state.mode !== mode) {
    return false;
  }
  return stickyModes.has(mode);
}

export function consumeTransient(): InjectionMode | null {
  if (state.mode === "none" || stickyModes.has(state.mode)) {
    return null;
  }

  const mode = state.mode;
  state.ttlRequests -= 1;
  if (state.ttlRequests <= 0) {
    state = { mode: "none", ttlRequests: 0 };
  }
  return mode;
}
