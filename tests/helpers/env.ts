/** The disposable data directory `tests/setup.mjs` created for this process. */
export const dataDir: string = process.env.OPENNAS_DATA_DIR ?? "";

if (!dataDir) {
  throw new Error(
    "OPENNAS_DATA_DIR is unset - tests must be run through `node --import ./tests/setup.mjs`, " +
      "which is what `npm test` does.",
  );
}
