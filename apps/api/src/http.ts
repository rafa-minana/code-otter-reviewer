export const HTTP_STATUS = {
  ok: 200,
  accepted: 202,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  notFound: 404,
  conflict: 409,
  payloadTooLarge: 413,
  serviceUnavailable: 503,
} as const;
