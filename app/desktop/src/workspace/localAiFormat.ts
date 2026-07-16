// Byte-size display formatters shared across the Local AI card and its section
// views (hardware readout, catalogue rows, installed rows, the delete confirm).
// Pure presentation helpers — no state, no data loading.

const GIB = 1024 ** 3;
/** Whole-GB label for memory sizes (hardware readout, min-RAM). */
export const wholeGb = (bytes: number) => `${Math.round(bytes / GIB)} GB`;
/** One-decimal GB label for download/disk sizes. */
export const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;
