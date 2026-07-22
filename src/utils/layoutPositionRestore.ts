/** Helpers for reusing graph positions when the visible node set changes. */

export function layoutRestoreIsSufficient(nodesLength: number, restored: number): boolean {
  if (nodesLength <= 0) return false;
  return restored >= Math.floor(nodesLength * 0.8);
}
