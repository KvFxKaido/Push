/** Returns true only on April 1st (local time). */
export function isAprilFirst(now: Date = new Date()): boolean {
  return now.getMonth() === 3 && now.getDate() === 1;
}
