export class TourSession {
  constructor() {
    this.version = 0;
    this.controller = null;
  }

  start() {
    this.cancel();
    const controller = new AbortController();
    const version = this.version;
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.controller === controller && this.version === version && !controller.signal.aborted,
    };
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
    this.version += 1;
  }

  complete(session) {
    if (!session.isCurrent()) return false;
    this.controller = null;
    return true;
  }
}

export function waitForTour(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException("Tour cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Tour cancelled", "AbortError"));
      },
      { once: true },
    );
  });
}
