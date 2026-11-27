/**
 * Encodes and decodes pediatric growth chart tracking strings.
 * 
 * Format Specification:
 * - Prefix: Gestational age token `g{weeks}w{days}d_` followed by 8-digit Date of Birth DDMMYYYY,
 *   Sex ('M' or 'F'), and an underscore '_' (e.g. g40w0d_01012020M_). Weeks/days are stored already
 *   normalised (days 0-6). The growth standard is intentionally NOT stored - it is re-derived on import.
 * - Payload: Unpadded Base64URL-encoded binary stream of measurement records, ordered by ascending
 *   day-offset so the string is identical regardless of the order readings were entered.
 * - Record Layout: Each timepoint is exactly 8 bytes (4 sequential little-endian uint16 values, scaled by 100):
 *   1. uint16 (bytes 0-1): Days since DoB (offset in days).
 *   2. uint16 (bytes 2-3): Weight in kg * 100 (2 decimal places).
 *   3. uint16 (bytes 4-5): Height/Length in cm * 100 (2 decimal places).
 *   4. uint16 (bytes 6-7): Head Circumference in cm * 100 (2 decimal places).
 */

export interface DecodedMeasurement {
  id: string;
  currentDate: string;
  directAgeY: number | '';
  directAgeM: number | '';
  directAgeD: number | '';
  weight: number | '';
  height: number | '';
  hc: number | '';
  sys: number | '';
  dia: number | '';
}

export interface DecodedTrackingData {
  dob: string; // YYYY-MM-DD
  sex: 'male' | 'female';
  gestationWeeks: number;
  gestationDays: number;
  measurements: DecodedMeasurement[];
}

export function encodeTrackingString(
  dob: string,
  sex: 'male' | 'female' | null,
  measurements: {
    currentDate?: string;
    directAgeY?: number | '';
    directAgeM?: number | '';
    directAgeD?: number | '';
    weight?: number | '';
    height?: number | '';
    hc?: number | '';
  }[],
  gestation?: { weeks: number; days: number } | null
): string {
  // If no measurements or no valid date/sex, return empty
  if (!measurements || measurements.length === 0) return '';

  let dobDateMs: number | null = null;
  let dobFormatted = '01012000'; // fallback DDMMYYYY

  if (dob) {
    const parts = dob.split('-');
    if (parts.length === 3) {
      const [y, m, d] = parts;
      dobFormatted = `${d.padStart(2, '0')}${m.padStart(2, '0')}${y}`;
      dobDateMs = Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    }
  }

  const sexCode = sex === 'female' ? 'F' : 'M';
  const gWeeks = gestation?.weeks ?? 40;
  const gDays = gestation?.days ?? 0;
  const prefix = `g${gWeeks}w${gDays}d_${dobFormatted}${sexCode}_`;

  // Filter and convert valid measurements
  const validRecords: { offsetDays: number; weight: number; height: number; hc: number }[] = [];

  for (const m of measurements) {
    let offsetDays = 0;
    if (dobDateMs !== null && m.currentDate) {
      const cp = m.currentDate.split('-');
      if (cp.length === 3) {
        const curMs = Date.UTC(parseInt(cp[0], 10), parseInt(cp[1], 10) - 1, parseInt(cp[2], 10));
        if (!isNaN(curMs)) {
          const diff = Math.round((curMs - dobDateMs) / (1000 * 3600 * 24));
          if (diff < 0) continue;
          offsetDays = diff;
        }
      }
    } else {
      const y = typeof m.directAgeY === 'number' ? m.directAgeY : 0;
      const mo = typeof m.directAgeM === 'number' ? m.directAgeM : 0;
      const d = typeof m.directAgeD === 'number' ? m.directAgeD : 0;
      offsetDays = Math.max(0, Math.round(y * 365.25 + mo * 30.4375 + d));
    }

    const weight = typeof m.weight === 'number' && m.weight > 0 ? Math.round(m.weight * 100) : 0;
    const height = typeof m.height === 'number' && m.height > 0 ? Math.round(m.height * 100) : 0;
    const hc = typeof m.hc === 'number' && m.hc > 0 ? Math.round(m.hc * 100) : 0;

    // Only include readings that have at least one actual measurement.
    if (weight > 0 || height > 0 || hc > 0) {
      validRecords.push({
        offsetDays: Math.min(65535, offsetDays),
        weight: Math.min(65535, weight),
        height: Math.min(65535, height),
        hc: Math.min(65535, hc),
      });
    }
  }

  if (validRecords.length === 0) {
    return prefix;
  }

  // Order by ascending day-offset (value tie-breakers for equal dates) so identical
  // observation sets always yield an identical string regardless of entry order.
  validRecords.sort((a, b) =>
    a.offsetDays - b.offsetDays ||
    a.weight - b.weight ||
    a.height - b.height ||
    a.hc - b.hc
  );

  const buffer = new ArrayBuffer(validRecords.length * 8);
  const view = new DataView(buffer);

  validRecords.forEach((rec, idx) => {
    const byteOffset = idx * 8;
    view.setUint16(byteOffset, rec.offsetDays, true);
    view.setUint16(byteOffset + 2, rec.weight, true);
    view.setUint16(byteOffset + 4, rec.height, true);
    view.setUint16(byteOffset + 6, rec.hc, true);
  });

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${prefix}${base64url}`;
}

export function decodeTrackingString(trackingStr: string): DecodedTrackingData | null {
  const trimmed = trackingStr.trim();
  if (!trimmed) return null;

  // New format only: a leading gestational-age token `g{weeks}w{days}d_` is required.
  const gaMatch = trimmed.match(/^g(\d{1,2})w(\d)d_(.*)$/);
  if (!gaMatch) return null;
  const gestationWeeks = parseInt(gaMatch[1], 10);
  const gestationDays = parseInt(gaMatch[2], 10);
  if (gestationWeeks < 21 || gestationWeeks > 44 || gestationDays > 6) return null;

  const match = gaMatch[3].match(/^(\d{2})(\d{2})(\d{4})([MFmf])_(.*)$/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  const sexCode = match[4].toUpperCase();
  const payload = match[5];

  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
    return null;
  }

  const dobFormatted = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dobDateMs = Date.UTC(year, month - 1, day);
  if (isNaN(dobDateMs)) return null;
  const dobCheck = new Date(dobDateMs);
  if (
    dobCheck.getUTCFullYear() !== year ||
    dobCheck.getUTCMonth() !== month - 1 ||
    dobCheck.getUTCDate() !== day
  ) {
    return null;
  }

  const sex: 'male' | 'female' = sexCode === 'F' ? 'female' : 'male';
  const measurements: DecodedMeasurement[] = [];

  if (payload.length > 0) {
    try {
      let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) {
        b64 += '=';
      }
      const binStr = atob(b64);
      if (binStr.length % 8 !== 0) {
        return null;
      }

      const count = binStr.length / 8;
      const buffer = new ArrayBuffer(binStr.length);
      const uint8 = new Uint8Array(buffer);
      for (let i = 0; i < binStr.length; i++) {
        uint8[i] = binStr.charCodeAt(i);
      }
      const view = new DataView(buffer);

      for (let i = 0; i < count; i++) {
        const byteOffset = i * 8;
        const offsetDays = view.getUint16(byteOffset, true);
        const weightRaw = view.getUint16(byteOffset + 2, true);
        const heightRaw = view.getUint16(byteOffset + 4, true);
        const hcRaw = view.getUint16(byteOffset + 6, true);

        const currentDate = new Date(dobDateMs + offsetDays * 24 * 3600 * 1000).toISOString().split('T')[0];

        measurements.push({
          id: `m_imp_${Date.now()}_${i}`,
          currentDate,
          directAgeY: '',
          directAgeM: '',
          directAgeD: '',
          weight: weightRaw > 0 ? Number((weightRaw / 100).toFixed(2)) : '',
          height: heightRaw > 0 ? Number((heightRaw / 100).toFixed(2)) : '',
          hc: hcRaw > 0 ? Number((hcRaw / 100).toFixed(2)) : '',
          sys: '',
          dia: '',
        });
      }
    } catch {
      return null;
    }
  }

  // If payload had no measurements, supply one empty measurement on DOB
  if (measurements.length === 0) {
    measurements.push({
      id: `m_imp_${Date.now()}_0`,
      currentDate: dobFormatted,
      directAgeY: '',
      directAgeM: '',
      directAgeD: '',
      weight: '',
      height: '',
      hc: '',
      sys: '',
      dia: '',
    });
  }

  return {
    dob: dobFormatted,
    sex,
    gestationWeeks,
    gestationDays,
    measurements,
  };
}
