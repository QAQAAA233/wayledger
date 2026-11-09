// A small JSON-schema check, enough for the tool arguments the agent sends. Anything unknown is rejected, so a model
// cannot smuggle an extra field past the code that reads the arguments.
export function validate(schema, v, path = 'arguments') {
  const errs = [];
  if (schema.type === 'object') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return [`${path} must be an object`];
    for (const r of schema.required ?? []) if (!(r in v) || v[r] === undefined) errs.push(`${path}.${r} is required`);
    for (const k of Object.keys(v)) {
      if (!schema.properties?.[k]) errs.push(`${path}.${k} is not a known field`);
      else errs.push(...validate(schema.properties[k], v[k], `${path}.${k}`));
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(v)) return [`${path} must be an array`];
    if (schema.maxItems && v.length > schema.maxItems) errs.push(`${path} may have at most ${schema.maxItems} entries`);
    v.forEach((x, i) => errs.push(...validate(schema.items, x, `${path}[${i}]`)));
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(v)) errs.push(`${path} must be a whole number`);
  } else if (schema.type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${path} must be a number`);
  } else if (schema.type === 'string') {
    if (typeof v !== 'string') errs.push(`${path} must be text`);
    else if (schema.enum && !schema.enum.includes(v)) errs.push(`${path} must be one of ${schema.enum.join(', ')}`);
    else if (schema.maxLength && v.length > schema.maxLength) errs.push(`${path} is too long`);
  } else if (schema.type === 'boolean') {
    if (typeof v !== 'boolean') errs.push(`${path} must be true or false`);
  }
  return errs;
}

// Arguments arrive as a JSON string; a model sometimes sends something that is not JSON. Parse without throwing.
export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return { ok: true, value: raw };
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, error: 'arguments must be a JSON object' };
  } catch {
    return { ok: false, error: 'arguments were not valid JSON' };
  }
}
