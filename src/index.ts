import { handleIncomingEmail } from './inbound';
import { handleRequest } from './api';

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  FROM_DOMAIN: string;
  OCI_SMTP_HOST: string;
  OCI_SMTP_PORT: string;
  OCI_SMTP_USER: string;
  OCI_SMTP_PASS: string;
  AUTH_SECRET: string;
}

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleIncomingEmail(message, env, ctx);
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
