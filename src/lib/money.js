// Money, in one place.
//
// Every amount in the storefront is a whole number of paise. Rupees are only
// ever produced for display, never held or arithmetic'd — ₹1,499.99 cannot be
// represented exactly in binary floating point, and a rounding error in a
// figure somebody is asked to pay is not an acceptable class of bug.

/// Paise from a rupee figure a person typed. "1499.50" → 149950.
///
/// Rejects anything that is not a plain amount, rather than guessing: a price
/// that silently became NaN would be charged as zero.
export function toMinor(value) {
  const text = String(value ?? '').trim().replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  const paise = Number(`${fraction}00`.slice(0, 2));
  return Number(whole) * 100 + paise;
}

/// Rupees for display, with Indian digit grouping.
export function formatMinor(minor, currency = 'INR') {
  if (minor === null || minor === undefined) return '';
  const rupees = Math.trunc(Math.abs(minor) / 100);
  const paise = Math.abs(minor) % 100;
  const grouped = groupIndian(rupees);
  const sign = minor < 0 ? '-' : '';
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  // Paise are shown only when there are any: "₹999" reads better than
  // "₹999.00", and "₹1,499.50" must not lose its fifty.
  return `${sign}${symbol}${grouped}${paise ? `.${String(paise).padStart(2, '0')}` : ''}`;
}

/// 1234567 → "12,34,567". The last three digits group in threes, everything
/// above them in twos, which is how rupees are written.
function groupIndian(whole) {
  const text = String(whole);
  if (text.length <= 3) return text;
  const last3 = text.slice(-3);
  const rest = text.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/// The plain decimal a form field should hold: 149950 → "1499.50".
export const toEditable = (minor) =>
  minor === null || minor === undefined ? '' : (minor / 100).toFixed(2).replace(/\.00$/, '');
