import type { Router } from "express";

const MOUNT_PATHS = new WeakMap<Router, string>();

/**
 * `parent.use(path, child)` that also records where the child is mounted, so the route
 * inventory can print full paths (Express itself does not keep them).
 */
export function mount(parent: Router, path: string, child: Router): void {
  MOUNT_PATHS.set(child, path);
  parent.use(path, child);
}

export function mountPathOf(router: Router): string | undefined {
  return MOUNT_PATHS.get(router);
}
