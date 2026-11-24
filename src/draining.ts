// Set once the process has begun a graceful shutdown. New long-polls return at once instead of
// holding a connection the exiting process will drop. No imports, so any module can read it.
let draining = false;

export function isDraining(): boolean {
  return draining;
}

export function setDraining(value: boolean): void {
  draining = value;
}
