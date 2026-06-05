import type { HostToWebview, WebviewToHost } from '../shared/types';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
}

declare global {
  interface Window {
    acquireVsCodeApi(): VsCodeApi;
  }
}

let api: VsCodeApi | null = null;

export function getVsCode(): VsCodeApi {
  if (api) return api;
  api = window.acquireVsCodeApi();
  return api;
}

export function post(message: WebviewToHost): void {
  getVsCode().postMessage(message);
}

export type HostMessage = HostToWebview;

export function onHostMessage(handler: (msg: HostMessage) => void): () => void {
  const listener = (event: MessageEvent) => {
    const data = event.data as HostMessage;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    handler(data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
