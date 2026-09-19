import { badRequest } from '../lib/errors.js';

/// Validates `req.body` against a zod schema and replaces it with the parsed
/// result, so handlers only ever see known, coerced fields.
export const validate = (schema) => (req, _res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => ({
      field: i.path.join('.') || '(body)',
      message: i.message,
    }));
    return next(badRequest('Please check the highlighted fields.', details));
  }
  req.body = parsed.data;
  next();
};
