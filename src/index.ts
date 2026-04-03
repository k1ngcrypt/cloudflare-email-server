import { handleIncomingEmail } from './inbound';
import { handleRequest } from './api';

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  FROM_DOMAIN: string;
  APP_ORIGIN?: string;
  OCI_EMAIL_ENDPOINT: string;
  OCI_EMAIL_CONTROL_ENDPOINT?: string;
  OCI_EMAIL_COMPARTMENT_OCID: string;
  OCI_EMAIL_API_TENANCY_OCID: string;
  OCI_EMAIL_API_USER_OCID: string;
  OCI_EMAIL_API_KEY_FINGERPRINT: string;
  OCI_EMAIL_API_PRIVATE_KEY: string;
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
