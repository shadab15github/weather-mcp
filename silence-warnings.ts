// Suppress the `ExperimentalWarning: SQLite is an experimental feature`
// emitted by `node:sqlite`. Must be imported BEFORE anything that loads
// `node:sqlite` (i.e. before `db.ts`), so it goes first in `server.ts`.

const origEmit = process.emit.bind(process);

(process as unknown as { emit: typeof process.emit }).emit = function (
  event: string | symbol,
  ...args: unknown[]
): boolean {
  if (event === "warning") {
    const warning = args[0] as { name?: string; message?: string } | undefined;
    if (
      warning?.name === "ExperimentalWarning" &&
      typeof warning?.message === "string" &&
      warning.message.includes("SQLite")
    ) {
      return false;
    }
  }
  return origEmit(event as never, ...(args as never[]));
};
