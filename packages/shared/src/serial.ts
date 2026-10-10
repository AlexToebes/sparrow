/** R26, D6: serials match case-insensitively after trimming. */
export function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase();
}
