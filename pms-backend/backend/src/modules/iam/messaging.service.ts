import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../../config/env';

/**
 * Outbound messages. Release 1 ships a stub: email delivery is implemented later behind this
 * interface (MessagingProvider adapter). In development and test the message is kept in memory
 * so the flow can be exercised end to end.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger('Messaging');
  /** Only populated outside production. */
  readonly outbox: Array<{ to: string; kind: string; token?: string; username?: string; subject?: string; text?: string }> = [];

  constructor(@Inject(ENV) private readonly env: Env) {}

  async sendPasswordReset(to: string, username: string, token: string): Promise<void> {
    if (this.env.NODE_ENV === 'production') {
      this.logger.warn(`Password reset requested for ${username}, but no email provider is configured.`);
      return;
    }
    this.outbox.push({ to, kind: 'password_reset', token, username });
    this.logger.debug(`[dev] password reset for ${username} <${to}>`);
  }

  /** One notification as an email. Delivery stays a stub until an email provider is connected. */
  async sendNotification(to: string, subject: string, text: string): Promise<void> {
    if (this.env.NODE_ENV === 'production') {
      this.logger.warn(`Notification email to ${to} not sent: no email provider is configured.`);
      return;
    }
    this.outbox.push({ to, kind: 'notification', subject, text });
  }
}
