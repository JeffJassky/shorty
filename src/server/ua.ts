import { isbot } from 'isbot';
import UAParser from 'ua-parser-js';
import type { Device } from '../../types/index.js';

/**
 * User-agent reading for the click pipeline. `ua-parser-js` is pinned to 1.x —
 * v2 is AGPL. `isbot('')` is false, so the empty-UA rule lives in `isBotHit`.
 */

export interface UaInfo {
  browser?: string;
  os?: string;
  device: Device;
}

/** Bot = HEAD, an empty/absent user agent, or a crawler UA. */
export function isBotHit(method: string, ua: string): boolean {
  return method === 'HEAD' || ua.trim() === '' || isbot(ua);
}

/** A declared crawler — the only audience for the custom social card. */
export function isCrawler(ua: string): boolean {
  return ua.trim() !== '' && isbot(ua);
}

function deviceOf(type: string | undefined): Device {
  switch (type) {
    case 'mobile': return 'mobile';
    case 'tablet': return 'tablet';
    case 'smarttv':
    case 'console':
    case 'wearable':
    case 'embedded':
      return 'other';
    default: return 'desktop';
  }
}

export function parseUa(ua: string): UaInfo {
  const result = new UAParser(ua).getResult();
  const info: UaInfo = { device: deviceOf(result.device.type) };
  if (result.browser.name) info.browser = result.browser.name;
  if (result.os.name) info.os = result.os.name;
  return info;
}
