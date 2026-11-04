// The exact same versioned table runs in Node and Chromium, regardless of their
// bundled ICU databases. timezone.js stays a classic script for both UI pages.
import '../site/timezone.js';
export const {moroccoParts,moroccoDay,moroccoOffsetMinutes,moroccoWallTime,tzdbVersion}=globalThis.LudyMoroccoTime;
