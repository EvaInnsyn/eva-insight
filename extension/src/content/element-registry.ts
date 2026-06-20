/**
 * Stable string IDs for DOM elements within a single content-script lifetime.
 *
 * - Each element gets a short identifier (`e0`, `e1`, ...) on first sighting.
 * - We cache element → id in a WeakMap so re-walks reuse the same id.
 * - We keep id → WeakRef<Element> so the LLM can refer to ids returned in an
 *   earlier read; resolution returns `null` if the element was removed from
 *   the DOM (the model gets a clear "stale element" signal).
 * - On URL navigation (SPA), the registry resets — old ids are intentionally
 *   invalidated because the page logically changed.
 */

interface RegistryShape {
  byElement: WeakMap<Element, string>;
  byId: Map<string, WeakRef<Element>>;
  nextId: number;
}

let registry: RegistryShape = empty();

function empty(): RegistryShape {
  return {
    byElement: new WeakMap(),
    byId: new Map(),
    nextId: 0,
  };
}

/** Returns the cached id for `el` or assigns a new one. */
export function getId(el: Element): string {
  const existing = registry.byElement.get(el);
  if (existing) return existing;
  const id = `e${registry.nextId++}`;
  registry.byElement.set(el, id);
  registry.byId.set(id, new WeakRef(el));
  return id;
}

/**
 * Resolve an id to a live Element. Returns `null` if the element was GC'd or
 * removed from the document. Callers should treat `null` as a "stale element"
 * condition and ask for a fresh page read.
 */
export function resolveId(id: string): Element | null {
  const ref = registry.byId.get(id);
  if (!ref) return null;
  const el = ref.deref();
  if (!el || !el.isConnected) {
    registry.byId.delete(id);
    return null;
  }
  return el;
}

/** Drop every entry. Called on URL navigation. */
export function resetRegistry(): void {
  registry = empty();
}

export function registrySize(): number {
  return registry.byId.size;
}
