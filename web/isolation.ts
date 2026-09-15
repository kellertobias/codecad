/** Switching isolated targets retains the view from before isolation began. */
export class IsolationSession<T> {
  path = "";
  private previous: T | undefined;
  toggle(path: string, capture: () => T): T | undefined {
    if (path === this.path) return this.restore();
    if (!this.path) this.previous = capture();
    this.path = path;
    return undefined;
  }
  restore(): T | undefined {
    const previous = this.previous;
    this.path = "";
    this.previous = undefined;
    return previous;
  }
}
