/**
 * Replace an own property on `target` for the duration of a test and restore the
 * EXACT prior state: the original own descriptor when there was one, otherwise the
 * property is deleted again.
 *
 * A bare `Object.defineProperty(obj, key, { value, configurable: true })` leaves a
 * NON-writable own property behind (`writable` defaults to false), and restoring
 * "only if a descriptor existed" leaves it there forever when the property was
 * inherited or absent (`process.stdout.isTTY` on a non-TTY). The next test file that
 * runs a plain `obj.key = …` then throws "Attempted to assign to readonly property".
 * Bun runs test files in filesystem order, so that leak only surfaced on CI's ext4
 * ordering, never on a developer's APFS — this helper makes the order irrelevant.
 */
export function overrideProperty<T extends object>(target: T, key: PropertyKey, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: original?.enumerable ?? true });
  return () => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<PropertyKey, unknown>)[key];
  };
}
