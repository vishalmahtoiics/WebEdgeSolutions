/// Normalises a value read from the environment.
///
/// Dashboards and .env files routinely introduce a trailing newline, a stray
/// space, or wrapping quotes when a value is pasted in. Those are invisible in
/// a UI but make an otherwise-correct secret fail validation, so strip them
/// before anything looks at the value.
export function cleanEnv(value) {
  if (value === undefined || value === null) return value;

  let out = String(value).trim();

  const first = out[0];
  const last = out[out.length - 1];
  if (out.length >= 2 && (first === '"' || first === "'") && first === last) {
    out = out.slice(1, -1).trim();
  }

  return out;
}

/// Reads and normalises an environment variable in one step.
export const env = (name) => cleanEnv(process.env[name]);
